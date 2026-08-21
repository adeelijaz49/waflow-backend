const path = require('path');

const PORT = process.env.PORT || 3000;
const rawAppUrl = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL = /^https?:\/\//.test(rawAppUrl) ? rawAppUrl : `https://${rawAppUrl}`;

// The Angular SPA's own URL (a different host from APP_URL) — used to build
// magic-link URLs that must land on the frontend, not the API.
const rawFrontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
const FRONTEND_URL = /^https?:\/\//.test(rawFrontendUrl) ? rawFrontendUrl : `https://${rawFrontendUrl}`;

// Local-dev-only fallback for uploaded images (utils/blobStorage.js).
// Previously assumed Azure App Service's /home path survives deploys/restarts —
// in production every previously-uploaded image was found missing (confirmed
// via direct testing), so that assumption didn't hold in practice. Production
// now uses Azure Blob Storage instead; this dir is only ever written to when
// AZURE_STORAGE_CONNECTION_STRING is unset (local dev).
const UPLOAD_DIR = path.join(process.env.HOME || path.join(__dirname, '..'), 'uploads');

module.exports = { PORT, APP_URL, FRONTEND_URL, UPLOAD_DIR };
