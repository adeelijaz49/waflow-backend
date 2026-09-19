// AI Mode prompt counting — enforces the "only user-triggered requests
// count" rule at the API boundary by only accepting a promptType from this
// fixed allow-list, rather than trusting a caller's boolean. Background
// Smart Insights generation, system maintenance jobs, failed AI responses,
// normal page loads and non-AI dashboard calculations must never call
// recordAiPrompt at all — there is deliberately no "don't count this one"
// escape hatch, since the allow-list is the enforcement.
const { checkEntitlement } = require('./entitlements');
const { recordUsageEvent } = require('./usageLedger');

const ALLOWED_PROMPT_TYPES = [
  'question',           // asking AI Mode a question
  'data_analysis',      // asking AI to analyse business data
  'campaign_draft',     // asking AI to draft a campaign
  'next_best_action',   // asking AI to suggest next-best actions
  'message_draft',      // asking AI to prepare a message or offer
];

async function checkAiPromptEntitlement(workspaceId) {
  return checkEntitlement(workspaceId, 'aiPromptsPerCycle', 1);
}

// Call only after a usable AI response was actually returned — a failed/
// empty response must not reach this function. metadata is free-form (e.g.
// { sessionId, model }) for later usage-history debugging.
async function recordAiPrompt({ workspaceId, userId, promptType, metadata }) {
  if (!ALLOWED_PROMPT_TYPES.includes(promptType)) {
    throw new Error(`promptType "${promptType}" is not a countable AI Mode prompt type`);
  }
  return recordUsageEvent({
    workspaceId, usageType: 'ai_prompt', quantity: 1,
    relatedUserId: userId, metadata: { promptType, ...metadata },
  });
}

module.exports = { ALLOWED_PROMPT_TYPES, checkAiPromptEntitlement, recordAiPrompt };
