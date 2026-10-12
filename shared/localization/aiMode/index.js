'use strict';
// Entry point of the Arabic AI Mode backend: wires the real dependencies for
// routes/localization/aiMode.js. Requiring this file has NO side effects: the
// Anthropic client, the tool registry (which builds a Stripe client at import),
// the Mongoose models and the insights engine are all required lazily, on the
// first request that needs them. Unit tests and the evaluation harness build
// their own agent with createAiModeAgent({ client, tools, ... }) and inject
// everything instead.
const { createAiModeAgent } = require('./agent');
const { createAiModeService, apiError } = require('./service');
const { createMongoSessionStore } = require('./sessionStore');
const { createModelLookups, createSettingsProvider } = require('./lookups');
const { loadRegistry, ACTION_TOOL_NAMES } = require('./tools');

// ai/client.js is required on first use. Without an API key the request fails
// fast with 503 AI_UNAVAILABLE instead of an opaque SDK error.
function createLazyClient() {
  return {
    messages: {
      async create(...args) {
        if (!process.env.ANTHROPIC_API_KEY) throw apiError(503, 'AI_UNAVAILABLE', 'The AI assistant is not configured.');
        return require('../../../ai/client').messages.create(...args);
      },
    },
  };
}

function createDefaultService() {
  const settings = createSettingsProvider();
  const sessions = createMongoSessionStore();
  const agent = createAiModeAgent({ client: createLazyClient(), tools: loadRegistry, sessions, lookups: createModelLookups(), settings });
  return createAiModeService({
    agent,
    sessions,
    settings,
    generateInsights: (args) => require('../../insights').generateInsights(args),
  });
}

let defaultService = null;
function getDefaultService() {
  if (!defaultService) defaultService = createDefaultService();
  return defaultService;
}

module.exports = { getDefaultService, createDefaultService, createAiModeAgent, createAiModeService, ACTION_TOOL_NAMES };
