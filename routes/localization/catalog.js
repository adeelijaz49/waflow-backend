// /api/localization/catalog — Arabic names and descriptions for products and services
// (spec §3.6). Mounted under requireAuth + the arabic_enabled gate (routes/localization/
// index.js), so req.user = { id, workspaceId, role }. All the rules (draft on change,
// ownership, caps, CSV matching) live in shared/localization/catalogTranslations.js;
// this file only does the HTTP plumbing:
//   * workspaceId comes ONLY from req.user, never from the path, query or body
//   * the save body goes through an explicit allow-list (pick) — a client cannot set
//     status, reviewer, workspace or kind through it
//   * every error body is { error, code } with a code from the closed set in CONTRACT §1
//     and nothing internal leaks (an unexpected failure is a generic INTERNAL 500)
const express = require('express');
const { csvUpload } = require('../../shared/localization/upload');
const { handler, pick } = require('../../shared/localization/scope');
const defaultService = require('../../shared/localization/catalogTranslations');

// scope.handler() forwards err.code untouched and never sets one on a 500.
const DEFAULT_CODES = { 400: 'INVALID_INPUT', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 413: 'FILE_TOO_LARGE', 429: 'RATE_LIMITED' };

function toApiError(err) {
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  const message = err && err.message;
  if (status >= 500) return Object.assign(new Error(message), { status: 500, code: 'INTERNAL' }); // handler() logs the cause, sends a generic body
  return Object.assign(new Error(message), { status, code: typeof err.code === 'string' ? err.code : DEFAULT_CODES[status] });
}

const api = (fn) => handler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    throw toApiError(err);
  }
});

const caller = (req) => ({ workspaceId: req.user && req.user.workspaceId, userId: req.user && req.user.id });

// Only an explicit "false" applies the file; a missing or unrecognised dryRun is a preview.
const APPLY_WORDS = new Set(['false', '0', 'no', 'off']);
const isDryRun = (value) => !APPLY_WORDS.has(String(value === undefined ? '' : value).trim().toLowerCase());

function createRouter(service = defaultService) {
  const router = express.Router();

  // ?kind=product|service|all &status=missing|draft|reviewed|all &search &page &limit
  router.get('/items', api(async (req, res) => {
    const { workspaceId } = caller(req);
    const { kind, status, search, page, limit } = req.query;
    res.json(await service.listItems({ workspaceId, kind, status, search, page, limit }));
  }));

  router.get('/export.csv', api(async (req, res) => {
    const csv = await service.exportCsv({ workspaceId: caller(req).workspaceId });
    res.set({ 'Content-Disposition': 'attachment; filename="catalog-arabic-names.csv"', 'Cache-Control': 'no-store' });
    res.type('text/csv').send(csv);
  }));

  // multipart: file + dryRun ('true' previews, 'false' applies)
  router.post('/import', csvUpload('file'), api(async (req, res) => {
    const { workspaceId, userId } = caller(req);
    const dryRun = isDryRun((req.body ?? {}).dryRun);
    res.json(await service.importCsv({ workspaceId, userId, buffer: req.file.buffer, dryRun }));
  }));

  // One item's current Arabic text for the Product / Service form (IM-D): { translation: view | null }.
  router.get('/:kind/:refId/translation', api(async (req, res) => {
    const { workspaceId } = caller(req);
    res.json(await service.getTranslation({ workspaceId, kind: req.params.kind, refId: req.params.refId }));
  }));

  router.put('/:kind/:refId/translation', api(async (req, res) => {
    const { workspaceId, userId } = caller(req);
    const body = pick(req.body ?? {}, ['name', 'description', 'source']);
    res.json(await service.saveTranslation({
      workspaceId, userId, kind: req.params.kind, refId: req.params.refId,
      name: body.name, description: body.description, source: body.source,
    }));
  }));

  router.post('/:kind/:refId/translation/review', api(async (req, res) => {
    const { workspaceId, userId } = caller(req);
    const { status } = pick(req.body ?? {}, ['status']);
    res.json(await service.reviewTranslation({ workspaceId, userId, kind: req.params.kind, refId: req.params.refId, status }));
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
