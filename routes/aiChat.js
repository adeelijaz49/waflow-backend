const router = require('express').Router();
const AiChatSession = require('../models/AiChatSession');
const { runTurn, confirmAction } = require('../ai/agent');

async function loadOrCreateSession(sessionId) {
  let session = await AiChatSession.findOne({ sessionId });
  if (!session) session = new AiChatSession({ sessionId, messages: [] });
  return session;
}

router.get('/session/:sessionId', async (req, res) => {
  try {
    const session = await AiChatSession.findOne({ sessionId: req.params.sessionId });
    if (!session) return res.json({ sessionId: req.params.sessionId, messages: [], pendingAction: null });
    res.json({ sessionId: session.sessionId, messages: session.messages, pendingAction: session.pendingAction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message are required' });

    const session = await loadOrCreateSession(sessionId);
    const { reply, pendingAction } = await runTurn(session, message);
    await session.save();

    res.json({ sessionId, reply, pendingAction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/confirm-action', async (req, res) => {
  try {
    const { sessionId, actionId, confirm } = req.body;
    if (!sessionId || !actionId || typeof confirm !== 'boolean') {
      return res.status(400).json({ error: 'sessionId, actionId, and confirm (boolean) are required' });
    }

    const session = await AiChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { reply, pendingAction } = await confirmAction(session, actionId, confirm);
    await session.save();

    res.json({ sessionId, reply, pendingAction });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
