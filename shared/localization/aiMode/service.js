'use strict';
// Orchestration for the AI Mode endpoints: load the session, run the agent,
// persist, resolve the reply language, map every failure to a stable API error
// and (optionally) tell a metering hook that a prompt was answered. The route
// file stays thin; the agent (agent.js) knows nothing about HTTP or MongoDB.
//
// PROMPT METERING IS NOT WIRED (the English AI Mode is not metered either; audit
// R6 §2.9 / §7 Q1). Plan limits count PER PROMPT, not per token, and a
// multi-step tool loop is still one prompt. When the owner decides to meter,
// the one-line wiring is the `onPromptCompleted` dependency (a no-op by default),
// called once per answered merchant message, after it was saved, never for
// confirm/decline clicks and never for a failed turn:
//
//   createAiModeService({ ..., onPromptCompleted: ({ workspaceId, userId, sessionId, usage }) =>
//     require('../../aiPromptMetering').recordAiPrompt({ workspaceId, userId, promptType: 'question', metadata: { sessionId, usage } }) });
//
// (checkAiPromptEntitlement(workspaceId) would be awaited at the top of message()
// for the limit itself.) The hook can never fail or delay a reply: its errors are
// caught and logged.
const { localizeInsights } = require('./insights');

const KNOWN_CODES = new Set([
  'FORBIDDEN', 'INVALID_INPUT', 'INVALID_LANGUAGE', 'RATE_LIMITED', 'INTERNAL', 'SESSION_NOT_FOUND', 'ACTION_NOT_PENDING',
  'MESSAGE_REQUIRED', 'MESSAGE_TOO_LONG', 'AI_UNAVAILABLE', 'AI_FAILED', 'AI_RATE_LIMITED',
]);

function apiError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Everything that leaves the service is an error with {status, code} from the
// closed set and an English message that is safe to show. Upstream (Anthropic)
// errors are mapped by HTTP status and their text is never passed on.
function toApiError(err, log) {
  if (err && Number.isInteger(err.status) && KNOWN_CODES.has(err.code)) return err;
  if (err && Number.isInteger(err.status)) {
    if (err.status === 429) return apiError(429, 'AI_RATE_LIMITED', 'The AI assistant is busy. Please wait a moment and try again.');
    if ([401, 403, 503, 529].includes(err.status)) return apiError(503, 'AI_UNAVAILABLE', 'The AI assistant is not available right now.');
    return apiError(502, 'AI_FAILED', 'The AI assistant could not complete that request.');
  }
  if (err && /^(APIConnection|Anthropic)/.test(String(err.name))) return apiError(502, 'AI_FAILED', 'The AI assistant could not complete that request.');
  log('unexpected error:', err && err.message);
  return apiError(500, 'INTERNAL', 'Something went wrong');
}

const sessionNotFound = () => apiError(404, 'SESSION_NOT_FOUND', 'Session not found');

// agent: createAiModeAgent(...); sessions: sessionStore interface; settings:
// { getUserPrefs, getMerchantName } (optional); generateInsights: the engine's
// function (injected so tests never load it).
function createAiModeService({
  agent, sessions, settings, generateInsights,
  onPromptCompleted = () => {},
  log = (...a) => console.error('[localization][ai-mode]', ...a),
} = {}) {
  async function readPrefs(workspaceId, userId) {
    const defaults = { aiLanguage: 'auto', uiLanguage: 'en' };
    if (!settings || typeof settings.getUserPrefs !== 'function') return defaults;
    try {
      const prefs = await settings.getUserPrefs(workspaceId, userId);
      return {
        aiLanguage: ['auto', 'en', 'ar'].includes(prefs && prefs.aiLanguage) ? prefs.aiLanguage : defaults.aiLanguage,
        uiLanguage: prefs && prefs.uiLanguage === 'ar' ? 'ar' : 'en',
      };
    } catch (err) {
      log('could not read language preferences (using defaults):', err && err.message);
      return defaults;
    }
  }

  function meter(info) {
    try {
      Promise.resolve(onPromptCompleted(info)).catch((err) => log('prompt metering hook failed (ignored):', err && err.message));
    } catch (err) {
      log('prompt metering hook failed (ignored):', err && err.message);
    }
  }

  // request language -> saved preference -> 'auto'
  const pickLanguage = (requested, prefs) => requested || prefs.aiLanguage || 'auto';

  async function message({ workspaceId, userId, sessionId, message: text, language }) {
    try {
      const prefs = await readPrefs(workspaceId, userId);
      const session = await sessions.findOrCreate(sessionId, workspaceId);
      const before = session.messages.length;
      const turn = await agent.runTurn(session, text, workspaceId, { language: pickLanguage(language, prefs), fallbackLanguage: prefs.uiLanguage });
      await sessions.saveTurn({ sessionId, workspaceId, messages: session.messages.slice(before), pendingAction: session.pendingAction || null });
      meter({ workspaceId, userId, sessionId, usage: turn.usage, language: turn.language, proposedAction: !!turn.pendingAction });
      return { sessionId, reply: turn.reply, pendingAction: turn.pendingAction, language: turn.language, usage: turn.usage };
    } catch (err) {
      throw toApiError(err, log);
    }
  }

  async function confirm({ workspaceId, userId, sessionId, actionId, confirm: decision, language }) {
    try {
      const session = await sessions.find(sessionId, workspaceId);
      if (!session) throw sessionNotFound();
      const prefs = await readPrefs(workspaceId, userId);
      const before = session.messages.length;
      const result = await agent.confirmAction(session, actionId, decision, workspaceId, { language: pickLanguage(language, prefs), fallbackLanguage: prefs.uiLanguage });
      // The action has already run (or been declined): failing to save the reply
      // must not turn that into an error the merchant would read as "nothing happened".
      try {
        await sessions.appendMessages({ sessionId, workspaceId, messages: session.messages.slice(before) });
      } catch (err) {
        log('could not save the confirmation reply (the action itself is already done):', err && err.message);
      }
      return { reply: result.reply, pendingAction: null };
    } catch (err) {
      throw toApiError(err, log);
    }
  }

  // Unknown (or another workspace's) session -> an empty one, like the English route.
  async function getSession({ workspaceId, sessionId }) {
    try {
      const session = await sessions.find(sessionId, workspaceId);
      if (!session) return { sessionId, messages: [], pendingAction: null };
      return { sessionId, messages: session.messages, pendingAction: session.pendingAction || null };
    } catch (err) {
      throw toApiError(err, log);
    }
  }

  async function insights({ workspaceId, userId, language }) {
    try {
      let target = language;
      if (!target) {
        const prefs = await readPrefs(workspaceId, userId);
        target = prefs.aiLanguage === 'auto' ? prefs.uiLanguage : prefs.aiLanguage;
      }
      const cards = await generateInsights({ workspaceId, surface: 'aimode' });
      return { items: localizeInsights(cards, target) };
    } catch (err) {
      throw toApiError(err, log);
    }
  }

  return { message, confirm, getSession, insights };
}

module.exports = { KNOWN_CODES, apiError, toApiError, createAiModeService };
