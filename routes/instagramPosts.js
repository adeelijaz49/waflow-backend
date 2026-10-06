// Merchant-facing Instagram Promotion Scheduler API — mounted at
// /api/instagram-posts under the existing requireAuth JWT middleware.
// workspaceId is always forced from req.user, never taken from the request
// body, on every write below.
const router = require('express').Router();
const instagram = require('../shared/instagram');

router.get('/entitlement', async (req, res) => {
  try {
    const ent = await instagram.getOrCreateEntitlement(req.user.workspaceId);
    res.json({ enabled: ent.enabled, grantedAt: ent.grantedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/posts', async (req, res) => {
  try {
    res.json(await instagram.listPosts({ workspaceId: req.user.workspaceId, status: req.query.status }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/posts', async (req, res) => {
  try {
    const post = await instagram.createPost({ ...req.body, workspaceId: req.user.workspaceId, createdByUserId: req.user.id });
    res.status(201).json(post);
  } catch (err) {
    if (err.code === 'INSTAGRAM_NOT_ENABLED') return res.status(402).json({ error: err.message, code: err.code });
    res.status(400).json({ error: err.message });
  }
});

router.get('/posts/:id', async (req, res) => {
  try {
    res.json(await instagram.getPost({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Instagram promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/posts/:id', async (req, res) => {
  try {
    res.json(await instagram.updatePost({ ...req.body, id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/posts/:id/duplicate', async (req, res) => {
  try {
    res.status(201).json(await instagram.duplicatePost({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/posts/:id/cancel', async (req, res) => {
  try {
    res.json(await instagram.cancelPost({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/posts/:id/schedule', async (req, res) => {
  try {
    res.json(await instagram.schedulePost({ id: req.params.id, workspaceId: req.user.workspaceId, scheduledAt: req.body.scheduledAt }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/posts/:id/publish-now', async (req, res) => {
  try {
    // Ownership/workspace check first — publishPostNow itself takes a bare
    // post id (it's also called by the scheduler with no req.user in scope).
    await instagram.getPost({ id: req.params.id, workspaceId: req.user.workspaceId });
    const post = await instagram.publishPostNow(req.params.id);
    if (post.status === 'failed') return res.status(502).json(post);
    res.json(post);
  } catch (err) {
    if (err.message === 'Instagram promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.post('/posts/:id/generate-content', async (req, res) => {
  try {
    res.json(await instagram.generateContentForPost({ id: req.params.id, workspaceId: req.user.workspaceId, businessName: req.body.businessName }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/refine-content', async (req, res) => {
  try {
    res.json(await instagram.refineContent({ currentCaption: req.body.currentCaption, instruction: req.body.instruction }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/posts/:id/report', async (req, res) => {
  try {
    res.json(await instagram.getPostReport({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Instagram promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/posts/:id/jobs', async (req, res) => {
  try {
    res.json(await instagram.listPublishJobs({ workspaceId: req.user.workspaceId, instagramPostId: req.params.id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
