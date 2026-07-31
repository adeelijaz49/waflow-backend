require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const app = require('../server');
const AiChatSession = require('../models/AiChatSession');

const SESSION_ID = '__test_ai_chat_parallel_tools__';

describe('AI Mode handles Claude calling multiple tools in parallel', () => {
  beforeAll(async () => {
    await connectOnce();
  }, 15000);

  afterAll(async () => {
    await AiChatSession.deleteOne({ sessionId: SESSION_ID });
  });

  test('a question spanning two independent read tools does not 400', async () => {
    // Phrased to invite Claude to call two independent tools in one turn
    // (e.g. get_order_stats + get_top_loyalty_customers) - this is exactly the
    // shape that previously broke runTurn(), which only paired a tool_result
    // with the FIRST tool_use block in a response, corrupting the message
    // history sent back to Claude whenever it called more than one tool at once.
    const res = await request(app)
      .post('/api/ai-chat/message')
      .send({
        sessionId: SESSION_ID,
        message: 'Tell me both: how many total orders does the store have, and which customer has the most loyalty points? Use your tools for both facts.',
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.reply).toBe('string');
    expect(res.body.reply.length).toBeGreaterThan(0);
    expect(res.body.pendingAction).toBeNull();
  }, 45000);
});
