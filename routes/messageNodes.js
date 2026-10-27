const router = require('express').Router();
const ops = require('../shared/operations');

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createMessageNode({ ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getMessageNode({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'MessageNode not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updateMessageNode({ id: req.params.id, ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'MessageNode not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await ops.deleteMessageNode({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Template submit / status refresh failures. What the screen needs is a sentence it can show, so on top of the raw Meta answer
// (kept in `error`, as before) the reply carries `message`:
//   TEMPLATE_INVALID  400 { error: <sentences>, code, reasons: [...], message }   Meta would refuse the message: nothing was sent
//   number unusable   409 { error: 'whatsapp_number_unavailable', message }
//   Meta refused      400 { error: <Meta's answer, as before>, message: <its sentence> }
//   anything else     400 { error: <the error text> }   (exactly as before)
function templateFailure(err, res) {
  if (err && err.code === 'TEMPLATE_INVALID') {
    return res.status(400).json({ error: err.message, code: err.code, reasons: err.reasons, message: err.message });
  }
  if (err && err.code === 'WHATSAPP_NUMBER_UNAVAILABLE') {
    return res.status(409).json({ error: 'whatsapp_number_unavailable', message: err.message });
  }
  if (err && err.response && err.response.data) {
    const meta = err.response.data.error;
    return res.status(400).json({ error: err.response.data, message: (meta && (meta.error_user_msg || meta.message)) || err.message });
  }
  return res.status(400).json({ error: err.message });
}

router.post('/:id/submit-template', async (req, res) => {
  try {
    res.json(await ops.submitMessageNodeTemplate({ nodeId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    templateFailure(err, res);
  }
});

// The screen polls this while a message waits for approval: a check made in the last 20 seconds is returned as it is, so several
// open tabs or a quick re-poll do not each read the WhatsApp account's template list (Meta rate-limits those reads per account).
const REFRESH_MIN_AGE_MS = 20 * 1000;

router.post('/:id/refresh-status', async (req, res) => {
  try {
    res.json(await ops.refreshMessageNodeTemplateStatus({ nodeId: req.params.id, workspaceId: req.user.workspaceId, minAgeMs: REFRESH_MIN_AGE_MS }));
  } catch (err) {
    templateFailure(err, res);
  }
});

module.exports = router;
