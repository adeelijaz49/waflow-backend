const router = require('express').Router();
const insights = require('../shared/insights');

router.get('/', async (req, res) => {
  try {
    res.json(await insights.generateInsights({ workspaceId: req.user.workspaceId, surface: req.query.surface }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/status', async (req, res) => {
  try {
    const { insightKey, status, rawMetric } = req.body;
    if (!insightKey || !status) return res.status(400).json({ error: 'insightKey and status are required' });
    res.json(await insights.updateInsightStatus({ workspaceId: req.user.workspaceId, insightKey, status, rawMetric }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
