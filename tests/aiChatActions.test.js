require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const { authedAgent, getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const AiChatSession = require('../models/AiChatSession');
const Customer = require('../models/Customer');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');

const PROPOSE_SESSION = '__test_ai_chat_action_propose__';
const DECLINE_SESSION = '__test_ai_chat_action_decline__';
const STALE_SESSION = '__test_ai_chat_action_stale__';

describe('AI Mode action tools + confirm-gate (Phase 3)', () => {
  let promo, customer, request;

  beforeAll(async () => {
    await connectOnce();
    request = await authedAgent(app);
    const workspaceId = await getTestWorkspaceId(app);
    customer = await Customer.create({ firstname: '__test_ai_action__', lastname: 'Customer', phone: '15559990099', isDemo: true, workspaceId });
    promo = await Promotion.create({ name: '__test_ai_action_promo__', scope: 'products', customerType: 'cash', isDemo: true, workspaceId });
  }, 30000);

  afterAll(async () => {
    await AiChatSession.deleteMany({ sessionId: { $in: [PROPOSE_SESSION, DECLINE_SESSION, STALE_SESSION] } });
    await CampaignMessage.deleteMany({ promotion: promo._id });
    await Promotion.deleteOne({ _id: promo._id });
    await Customer.deleteOne({ _id: customer._id });
  });

  test('proposing send_promotion returns a pendingAction with zero side effects', async () => {
    const res = await request
      .post('/api/ai-chat/message')
      .send({
        sessionId: PROPOSE_SESSION,
        message: `Send the promotion with id ${promo._id} to the customer with id ${customer._id} over WhatsApp. Call the send tool now with these exact ids, don't ask me anything first.`,
      });

    expect(res.status).toBe(200);
    expect(res.body.pendingAction).toBeTruthy();
    expect(res.body.pendingAction.toolName).toBe('send_promotion');
    expect(res.body.pendingAction.id).toBeTruthy();

    const countBeforeConfirm = await CampaignMessage.countDocuments({ promotion: promo._id });
    expect(countBeforeConfirm).toBe(0);

    const confirmRes = await request
      .post('/api/ai-chat/confirm-action')
      .send({ sessionId: PROPOSE_SESSION, actionId: res.body.pendingAction.id, confirm: true });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.pendingAction).toBeNull();

    const countAfterConfirm = await CampaignMessage.countDocuments({ promotion: promo._id });
    expect(countAfterConfirm).toBe(1);
  }, 45000);

  test('declining a proposed action causes zero side effects', async () => {
    const countBefore = await CampaignMessage.countDocuments({ promotion: promo._id });

    const res = await request
      .post('/api/ai-chat/message')
      .send({
        sessionId: DECLINE_SESSION,
        message: `Send the promotion with id ${promo._id} to the customer with id ${customer._id} over WhatsApp. Call the send tool now with these exact ids, don't ask me anything first.`,
      });

    expect(res.status).toBe(200);
    expect(res.body.pendingAction).toBeTruthy();
    const actionId = res.body.pendingAction.id;

    const declineRes = await request
      .post('/api/ai-chat/confirm-action')
      .send({ sessionId: DECLINE_SESSION, actionId, confirm: false });

    expect(declineRes.status).toBe(200);
    expect(declineRes.body.pendingAction).toBeNull();

    const countAfter = await CampaignMessage.countDocuments({ promotion: promo._id });
    expect(countAfter).toBe(countBefore); // declined — no new send should have happened
  }, 45000);

  test('confirming a stale/unknown actionId returns 409 and does nothing', async () => {
    const res = await request
      .post('/api/ai-chat/message')
      .send({
        sessionId: STALE_SESSION,
        message: `Send the promotion with id ${promo._id} to the customer with id ${customer._id} over WhatsApp. Call the send tool now with these exact ids, don't ask me anything first.`,
      });

    expect(res.status).toBe(200);
    expect(res.body.pendingAction).toBeTruthy();

    const staleRes = await request
      .post('/api/ai-chat/confirm-action')
      .send({ sessionId: STALE_SESSION, actionId: 'not-the-real-action-id', confirm: true });

    expect(staleRes.status).toBe(409);
  }, 45000);
});
