// Simple static API-key auth for the ChatGPT Custom GPT Actions surface.
// Separate from the MCP/Claude OAuth layer by design — GPT Actions' "API Key"
// auth type just wants a single bearer token, no OAuth dance required.
function requireApiKey(req, res, next) {
  const key = process.env.GPT_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured', message: 'GPT_API_KEY is not set on the server.' });

  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match || match[1] !== key) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  next();
}

module.exports = { requireApiKey };
