const PORT = process.env.PORT || 3000;
const rawAppUrl = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL = /^https?:\/\//.test(rawAppUrl) ? rawAppUrl : `https://${rawAppUrl}`;

module.exports = { PORT, APP_URL };
