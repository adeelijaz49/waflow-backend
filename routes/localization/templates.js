// /api/localization/templates — message templates with one variant per language:
// CRUD, library, server-side preview, validation, review, submission to Meta,
// status refresh and test sends (spec §3.2 / §4 / §8). Mounted under requireAuth
// + requireArabicEnabled (routes/localization/index.js). Same rules as
// settings.js: workspaceId only from req.user, bodies copied through explicit
// allow-lists, handler() so nothing but { error, code } ever leaks.
//
// Static paths (library, from-library, meta-usage, preview, refresh-status) are registered
// BEFORE the /:id routes — otherwise "library" would be taken for a template id.
//
// The service raises TemplateError for everything it expects (it carries the full
// JSON body: VARIANT_INVALID + issues, META_ERROR + metaError, ...); those are
// answered here as-is, including 5xx ones that are deliberate (502/503 from
// Meta), and anything else falls through to the shared handler (500, no details).
const express = require('express');
const { handler, pick } = require('../../shared/localization/scope');
const defaultService = require('../../shared/localization/templates');

function route(fn) {
  return handler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.expose === true && err.body && Number.isInteger(err.status)) {
        if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
        res.status(err.status).json(err.body);
        return;
      }
      throw err;
    }
  });
}

const scope = (req) => ({ workspaceId: req.user.workspaceId, userId: req.user.id });
const body = (req, keys) => pick(req.body ?? {}, keys);

// `templates` is injectable so the HTTP tests can run the real router against an in-memory service.
function createRouter(templates = defaultService) {
  const router = express.Router();

  router.get('/', route(async (req, res) => {
    res.json(await templates.listTemplates({ workspaceId: req.user.workspaceId, ...pick(req.query, ['search', 'useCase', 'archived', 'page', 'limit']) }));
  }));

  router.post('/', route(async (req, res) => {
    res.status(201).json(await templates.createTemplate({ ...scope(req), ...body(req, ['name', 'useCase', 'category', 'variants', 'key']) }));
  }));

  router.get('/library', route(async (req, res) => {
    res.json({ items: await templates.listLibrary() });
  }));

  router.post('/from-library', route(async (req, res) => {
    res.status(201).json(await templates.createFromLibrary({ ...scope(req), ...body(req, ['libraryKey', 'name']) }));
  }));

  router.get('/meta-usage', route(async (req, res) => {
    res.json(await templates.getMetaUsage());
  }));

  router.post('/preview', route(async (req, res) => {
    res.json(await templates.renderPreview({ workspaceId: req.user.workspaceId, ...body(req, ['variant', 'fieldValues', 'customerId']) }));
  }));

  router.post('/refresh-status', route(async (req, res) => {
    res.json(await templates.refreshStatuses({ workspaceId: req.user.workspaceId, ...body(req, ['templateId']) }));
  }));

  router.get('/:id', route(async (req, res) => {
    res.json(await templates.getTemplate({ workspaceId: req.user.workspaceId, id: req.params.id }));
  }));

  router.put('/:id', route(async (req, res) => {
    res.json(await templates.updateTemplate({ workspaceId: req.user.workspaceId, id: req.params.id, patch: body(req, ['name', 'useCase', 'category']) }));
  }));

  router.post('/:id/archive', route(async (req, res) => {
    res.json(await templates.setArchived({ workspaceId: req.user.workspaceId, id: req.params.id, archived: true }));
  }));

  router.post('/:id/unarchive', route(async (req, res) => {
    res.json(await templates.setArchived({ workspaceId: req.user.workspaceId, id: req.params.id, archived: false }));
  }));

  router.put('/:id/variants/:language', route(async (req, res) => {
    res.json(await templates.upsertVariant({ ...scope(req), id: req.params.id, language: req.params.language, input: req.body ?? {} }));
  }));

  router.post('/:id/variants/:language/validate', route(async (req, res) => {
    res.json(await templates.validateVariantFor({ workspaceId: req.user.workspaceId, id: req.params.id, language: req.params.language, input: req.body ?? {} }));
  }));

  router.post('/:id/variants/:language/submit', route(async (req, res) => {
    res.json(await templates.submitVariant({ ...scope(req), id: req.params.id, language: req.params.language }));
  }));

  router.post('/:id/variants/:language/review', route(async (req, res) => {
    res.json(await templates.reviewVariant({ ...scope(req), id: req.params.id, language: req.params.language, ...body(req, ['status']) }));
  }));

  router.post('/:id/variants/:language/test-send', route(async (req, res) => {
    res.json(await templates.testSendVariant({ ...scope(req), id: req.params.id, language: req.params.language, ...body(req, ['phone']) }));
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
