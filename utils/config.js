const path = require('path');

const PORT = process.env.PORT || 3000;
const rawAppUrl = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL = /^https?:\/\//.test(rawAppUrl) ? rawAppUrl : `https://${rawAppUrl}`;

// Azure App Service (Linux) persists everything under /home across deploys and
// restarts — a deploy only replaces /home/site/wwwroot, so uploaded files
// living anywhere else under /home survive. Falls back to a local ./uploads
// dir (gitignored) outside of Azure.
const UPLOAD_DIR = path.join(process.env.HOME || path.join(__dirname, '..'), 'uploads');

module.exports = { PORT, APP_URL, UPLOAD_DIR };
