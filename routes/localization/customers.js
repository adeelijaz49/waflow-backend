// /api/localization/customers — each customer's language (spec §3.1): list with
// Arabic-aware search, set one, set many, CSV import (dry run first), CSV export
// and the downloadable template. Mounted by routes/localization/index.js behind
// requireAuth + requireArabicEnabled, so req.user = { id, workspaceId, role }.
// Same rules as routes/localization/settings.js (the reference):
//   * workspaceId comes ONLY from req.user — a workspaceId in the query, body or
//     multipart fields is never read;
//   * ids, languages and search text are validated before any query runs
//     (operator-injection bodies such as {"$ne":null} become 400s);
//   * handler() turns thrown { status, code } errors into { error, code } JSON.
// All logic lives in shared/localization/customerLanguage.js.
const router = require('express').Router();
const customers = require('../../shared/localization/customerLanguage');
const { csvUpload } = require('../../shared/localization/upload');
const { handler } = require('../../shared/localization/scope');

function sendCsv(res, filename, text) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send(text);
}

router.get('/', handler(async (req, res) => {
  const query = req.query ?? {};
  res.json(await customers.listCustomers({
    workspaceId: req.user.workspaceId,
    search: customers.parseSearch(query.search),
    language: customers.parseLanguageFilter(query.language),
    page: query.page,
    limit: query.limit,
  }));
}));

router.put('/:id/language', handler(async (req, res) => {
  res.json(await customers.setCustomerLanguage({
    workspaceId: req.user.workspaceId,
    customerId: req.params.id,
    language: (req.body ?? {}).language,
    userId: req.user.id,
  }));
}));

router.post('/language/bulk', handler(async (req, res) => {
  const body = req.body ?? {};
  res.json(await customers.bulkSetCustomerLanguage({
    workspaceId: req.user.workspaceId,
    customerIds: body.customerIds,
    language: body.language,
    userId: req.user.id,
  }));
}));

// multipart: `file` + `dryRun` ('true' | 'false'). Anything but an explicit
// false is a dry run, so a client that forgets the field can never write.
router.post('/language/import', csvUpload('file'), handler(async (req, res) => {
  res.json(await customers.importLanguages({
    workspaceId: req.user.workspaceId,
    userId: req.user.id,
    file: req.file,
    dryRun: customers.parseDryRun((req.body ?? {}).dryRun),
  }));
}));

router.get('/language/template.csv', handler(async (req, res) => {
  sendCsv(res, 'waflow-customer-languages-template.csv', customers.templateCsv());
}));

router.get('/language/export.csv', handler(async (req, res) => {
  sendCsv(res, 'waflow-customer-languages.csv', await customers.exportCsv({ workspaceId: req.user.workspaceId }));
}));

module.exports = router;
