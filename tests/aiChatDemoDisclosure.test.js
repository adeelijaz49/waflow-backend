require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const { authedAgent } = require('./testAuth');
const app = require('../server');
const AiChatSession = require('../models/AiChatSession');
const Customer = require('../models/Customer');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');

const SESSION_ID = '__test_ai_chat_demo_disclosure__';

describe('AI Mode discloses when a "successful" send was actually simulated', () => {
  let promo, customer, request;

  beforeAll(async () => {
    await connectOnce();
    request = await authedAgent(app);
    customer = await Customer.create({ firstname: '__test_ai_disclosure__', lastname: 'Customer', phone: '15559990299', isDemo: true });
    promo = await Promotion.create({ name: '__test_ai_disclosure_promo__', scope: 'products', customerType: 'cash', isDemo: true });
  }, 30000);

  afterAll(async () => {
    await AiChatSession.deleteOne({ sessionId: SESSION_ID });
    await CampaignMessage.deleteMany({ promotion: promo._id });
    await Promotion.deleteOne({ _id: promo._id });
    await Customer.deleteOne({ _id: customer._id });
  });

  // Root-caused a real production incident (2026-08-01): a merchant asked AI
  // Mode to send a demo-flagged promotion; sendPromotion() correctly simulated
  // it (Demo Mode isolation - no real WhatsApp call), but confirmAction()'s
  // reply said only "Done" with no indication the send wasn't real. The
  // merchant reasonably believed a real message had gone out.
  test('confirming a send for a demo-flagged promotion discloses it was simulated', async () => {
    const proposeRes = await request
      .post('/api/ai-chat/message')
      .send({
        sessionId: SESSION_ID,
        message: `Send the promotion with id ${promo._id} to the customer with id ${customer._id} over WhatsApp. Call the send tool now with these exact ids, don't ask me anything first.`,
      });
    expect(proposeRes.status).toBe(200);
    expect(proposeRes.body.pendingAction?.toolName).toBe('send_promotion');

    const confirmRes = await request
      .post('/api/ai-chat/confirm-action')
      .send({ sessionId: SESSION_ID, actionId: proposeRes.body.pendingAction.id, confirm: true });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.reply).toMatch(/simulated/i);
    expect(confirmRes.body.reply).toMatch(/no real WhatsApp message was sent/i);

    const cm = await CampaignMessage.findOne({ promotion: promo._id, customer: customer._id });
    expect(cm.wamid).toMatch(/^demo_/); // proves the underlying send really was simulated, not just the wording
  }, 45000);
});
