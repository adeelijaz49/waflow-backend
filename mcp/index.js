const router = require('express').Router();
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { requireBearerAuth } = require('./oauth');
const { createMcpServer } = require('./tools');

// Stateless mode: one MCP server + transport per request, no session persistence
// needed across requests. Fine for a single-admin, low-concurrency connector.
router.post('/', requireBearerAuth, async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  }
});

router.get('/', requireBearerAuth, (req, res) => {
  res.status(405).json({ error: 'method_not_allowed', error_description: 'This server runs stateless — no SSE stream to resume.' });
});

router.delete('/', requireBearerAuth, (req, res) => {
  res.status(405).json({ error: 'method_not_allowed' });
});

module.exports = router;
