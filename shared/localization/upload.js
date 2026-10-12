'use strict';
// Multipart CSV upload middleware shared by every localisation import
// (customer languages, Arabic product/service names). Memory storage, 5 MB,
// one file, CSV/text only. Errors become JSON ({error, code}) instead of
// Express's HTML default — same callback-form multer pattern as routes/imports.js.
// Text fields sent alongside the file (e.g. dryRun) land in req.body as strings.
const multer = require('multer');
const { MAX_BYTES } = require('./csv');

const ALLOWED_EXT = /\.(csv|txt|tsv)$/i;
const ALLOWED_MIME = new Set([
  'text/csv', 'text/plain', 'text/tab-separated-values', 'application/csv', 'application/vnd.ms-excel',
  'application/octet-stream', 'text/x-csv', 'application/x-csv',
]);

function fail(res, status, code, error) {
  return res.status(status).json({ error, code });
}

function csvUpload(field = 'file') {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 10 },
    fileFilter(req, file, cb) {
      if (ALLOWED_EXT.test(file.originalname || '') || ALLOWED_MIME.has(String(file.mimetype || '').toLowerCase())) return cb(null, true);
      const err = new Error('Only CSV files can be uploaded');
      err.code = 'FILE_INVALID';
      return cb(err);
    },
  }).single(field);

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'FILE_TOO_LARGE', 'The file is too large (max 5 MB)');
        return fail(res, 400, 'FILE_INVALID', 'Only CSV files can be uploaded');
      }
      if (!req.file) return fail(res, 400, 'FILE_REQUIRED', 'Choose a CSV file to upload');
      return next();
    });
  };
}

// "true" / "1" / "yes" -> true; anything else (including undefined) -> false.
function parseBooleanField(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value === undefined ? '' : value).trim().toLowerCase());
}

module.exports = { csvUpload, parseBooleanField };
