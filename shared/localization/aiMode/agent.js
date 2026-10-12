'use strict';
// The Arabic-capable AI Mode agent (spec §6; audit R6 option (b)): a NEW loop and
// confirm gate that import the existing tool registry, so the English agent
// (ai/agent.js, routes/aiChat.js) stays untouched and keeps working.
//
// ─── THE CONFIRM GATE (what must always be true) ─────────────────────────────
//  1. An action tool (registry flag `isAction`) is NEVER executed inside the
//     loop. When the model calls one, the loop validates the arguments, builds a
//     deterministic confirmation card from them (summaries.js) and RETURNS a
//     pending action. Only the first action block of a response is considered;
//     the others are never run.
//  2. The only code that executes an action is confirmAction(), and only
//     after the pending action's id matches. Execution always goes through
//     executeAction(), which throws for an action tool unless `confirmed`.
//  3. The pending action is CLAIMED before anything runs. With a session store
//     the claim is one atomic conditional update (sessions.claimPendingAction),
//     so two simultaneous confirms - a double click, a retry - cannot both
//     execute: exactly one wins and the other gets 409 ACTION_NOT_PENDING. (The
//     English agent clears the pending action in memory and saves afterwards, so
//     two in-flight confirms can both send.) If execution throws, the action is
//     still gone: a replay is 409, never a second attempt.
//  4. Arguments come from the SERVER-stored pending action, never from the
//     request, and are re-validated before running.
//  5. What the merchant confirms is text the server built from those same
//     arguments, not the model's prose (the model's sentence is returned only as
//     `modelNote`).
//  6. A request that no longer matches what is on screen cannot confirm it: any
//     new message supersedes a pending action.
//
// ─── Differences from ai/agent.js (all additive) ─────────────────────────────
//  * system-level instructions (prompt.js), reply-language override, the date
//    in Asia/Riyadh, merchant name; prompt caching of tools + static prompt;
//  * the merchant's text is normalised for the model (digits) but stored as typed;
//  * tool arguments are coerced and validated first (tools.js): a malformed
//    call becomes an error result the model can fix, never a database call;
//  * an iteration cap (8) and a wall-clock budget, `max_tokens` handling,
//    oversize tool results trimmed, token usage accumulated across the loop;
//  * history is persisted as clean text only (user text + final reply); tool
//    blocks never reach the database;
//  * confirm/decline/failure/"could not finish"/demo-simulation texts are
//    deterministic and localised, with no second model call;
//  * a draft that was created (create_promotion / create_flow run un-gated in the
//    registry) is reported to the merchant even if the turn later fails.
//
// Everything external is injected (client, tools, sessions, lookups, settings,
// clock) so unit tests and the evaluation harness never touch the Anthropic API,
// the database or Stripe.
const crypto = require('crypto');
const catalog = require('../catalog');
const { detectLanguage } = require('../languageDetect');
const { createToolBridge, READ_TOOL_NAMES } = require('./tools');
const { buildSystemBlocks } = require('./prompt');
const { normalizeUserMessage } = require('./normalize');
const { hasActionIntent } = require('./intent');
const summaries = require('./summaries');

const DEFAULTS = Object.freeze({
  model: 'claude-sonnet-5', // same model id as ai/agent.js
  maxTokens: 4096,
  historyLimit: 20, // last 20 messages, like the English agent
  maxIterations: 8,
  requestTimeoutMs: 60 * 1000,
  turnBudgetMs: 150 * 1000,
  maxToolResultChars: 24000,
  promptCaching: true,
});
const MAX_MODEL_NOTE_LENGTH = 600;

const t = (language, key, params) => catalog.t(language === 'ar' ? 'ar' : 'en', `aimode.${key}`, params);
const isObject = (v) => v !== null && typeof v === 'object';
const num = (v) => (Number.isFinite(v) ? v : 0);

function coded(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const actionNotPending = () => coded(409, 'ACTION_NOT_PENDING', 'This action is no longer pending.');

function toDate(value) {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ── language ──────────────────────────────────────────────────────────────
// Override (request / saved preference) wins. In 'auto' the language the merchant
// wrote in wins; when that is unclear (only digits or emoji, a 50/50 mix) the
// conversation keeps the language it already had, then the account's UI
// language, then English (the default everywhere in the product).
function resolveReplyLanguage({ requested, detected, history, fallback }) {
  if (requested === 'ar' || requested === 'en') return requested;
  if (detected === 'ar' || detected === 'en') return detected;
  const prior = Array.isArray(history) ? history.slice(-40) : [];
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const m = prior[i];
    if (m && m.role === 'user' && typeof m.text === 'string') {
      const d = detectLanguage(m.text).language;
      if (d === 'ar' || d === 'en') return d;
    }
  }
  return fallback === 'ar' ? 'ar' : 'en';
}

// ── history for the model ─────────────────────────────────────────────────
// Last `limit` messages including the current one. User messages are normalised
// again (older stored text may still hold Arabic-Indic digits). The Messages API
// needs the first message to be a user message, which a plain slice does not
// guarantee once a conversation is longer than the window.
function toClaudeHistory(prior, limit, currentText) {
  const out = [];
  for (const m of prior.slice(-(limit - 1))) {
    if (!m || typeof m.text !== 'string') continue;
    if (m.role === 'user') {
      const text = normalizeUserMessage(m.text).text;
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant' && m.text.trim()) {
      out.push({ role: 'assistant', content: m.text.trim() });
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  out.push({ role: 'user', content: currentText });
  return out;
}

// ── tool results ──────────────────────────────────────────────────────────
function safeStringify(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  } catch {
    return JSON.stringify({ error: 'The tool result could not be serialised' });
  }
}

// Model-visible and logged error text: never a connection string, key or token.
function sanitizeErrorMessage(message) {
  return String(message || 'error')
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[redacted]')
    .replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// A tool result goes back to the model as text. Some are unbounded (e.g.
// list_inactive_customers returns EVERY inactive customer), which would burn
// tokens (Arabic costs more of them) or overflow the context. Over the cap the
// longest array is trimmed and `_truncated` tells the model how many there
// really were, so counting questions ("كم عميل...") stay correct.
function serializeToolResult(result, maxChars) {
  const json = safeStringify(result);
  if (json.length <= maxChars) return json;
  let data;
  try { data = JSON.parse(json); } catch { data = null; }
  let holder = null;
  let key = null;
  let array = null;
  if (Array.isArray(data)) {
    array = data;
  } else if (isObject(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && (!array || v.length > array.length)) { holder = data; key = k; array = v; }
    }
  }
  if (array) {
    const build = (shown) => {
      const meta = { field: key, shown, total: array.length };
      if (holder) return { ...holder, [key]: array.slice(0, shown), _truncated: meta };
      return { items: array.slice(0, shown), _truncated: meta };
    };
    let lo = 0;
    let hi = array.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (safeStringify(build(mid)).length <= maxChars) lo = mid; else hi = mid - 1;
    }
    const out = safeStringify(build(lo));
    if (out.length <= maxChars) return out;
  }
  return safeStringify({ _truncated: true, note: 'The result was too large; only the beginning is shown.', partial: json.slice(0, Math.max(0, maxChars - 200)) });
}

function toolResultBlock(id, payload, isError = false) {
  const block = { type: 'tool_result', tool_use_id: id, content: payload };
  if (isError) block.is_error = true;
  return block;
}

const errorBlock = (id, message) => toolResultBlock(id, safeStringify({ error: message }), true);

// ── usage ─────────────────────────────────────────────────────────────────
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function addUsage(acc, usage) {
  if (!isObject(usage)) return;
  acc.input += num(usage.input_tokens);
  acc.output += num(usage.output_tokens);
  acc.cacheRead += num(usage.cache_read_input_tokens);
  acc.cacheCreation += num(usage.cache_creation_input_tokens);
}

// `inputTokens` is the TOTAL prompt size (what tokenisation differences between
// Arabic and English show up in); the split is there for pricing.
function usageView(acc) {
  return {
    inputTokens: acc.input + acc.cacheRead + acc.cacheCreation,
    outputTokens: acc.output,
    uncachedInputTokens: acc.input,
    cacheReadTokens: acc.cacheRead,
    cacheCreationTokens: acc.cacheCreation,
  };
}

function joinText(content) {
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text.trim()).filter(Boolean).join('\n\n');
}

// ── the single execution funnel ───────────────────────────────────────────
// Every tool run in this module goes through here. An action tool only runs with
// confirmed === true, which only confirmAction() passes.
async function executeAction(tool, args, workspaceId, { confirmed = false } = {}) {
  if (!tool || typeof tool.run !== 'function') throw new Error('Unknown tool');
  if (tool.isAction && confirmed !== true) {
    const err = new Error('Action tools only run after the merchant has confirmed them');
    err.code = 'ACTION_NOT_CONFIRMED';
    throw err;
  }
  return tool.run(args, workspaceId);
}

// `tools` is a registry ({ getTool, toolsForClaude }) or a function returning
// one; `sessions`, `lookups` and `settings` are optional (see the header).
function createAiModeAgent({ client, tools, sessions, lookups, now = () => new Date(), settings, options = {}, log = (...a) => console.error('[localization][ai-mode]', ...a) } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const bridge = createToolBridge(tools);
  const clock = () => toDate(now());

  function askModel({ system, messages, timeoutMs }) {
    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      output_config: { effort: 'medium' },
      system: cfg.promptCaching
        ? [{ type: 'text', text: system.staticText, cache_control: { type: 'ephemeral' } }, { type: 'text', text: system.dynamicText }]
        : `${system.staticText}\n\n${system.dynamicText}`,
      tools: bridge.toolsForClaude(),
      messages,
    };
    return client.messages.create(body, { timeout: timeoutMs });
  }

  async function merchantNameFor(workspaceId) {
    if (!settings || typeof settings.getMerchantName !== 'function') return undefined;
    try { return await settings.getMerchantName(workspaceId); } catch { return undefined; }
  }

  function writeNote(language, writes) {
    const kinds = Array.from(new Set(writes.map((name) => (name === 'create_promotion' ? 'write.promotion' : name === 'create_flow' ? 'write.flow' : 'write.other'))));
    const phrases = kinds.map((key) => t(language, key));
    const what = phrases.length > 1
      ? `${phrases.slice(0, -1).join(language === 'ar' ? '، ' : ', ')}${language === 'ar' ? ' و' : ' and '}${phrases[phrases.length - 1]}`
      : phrases[0];
    return t(language, 'reply.partialWrite', { what });
  }

  // One merchant message -> one reply (or a pending action). Mutates `session`
  // only when the turn completes: { messages[], pendingAction }.
  async function runTurn(session, userMessage, workspaceId, opts = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!client || !client.messages || typeof client.messages.create !== 'function') throw new Error('AI Mode client is not configured');
    const started = clock().getTime();
    const normalized = normalizeUserMessage(userMessage);
    if (!normalized.text) throw coded(400, 'MESSAGE_REQUIRED', 'A message is required');
    if (!Array.isArray(session.messages)) session.messages = [];
    const prior = session.messages;
    const language = resolveReplyLanguage({ requested: opts.language, detected: normalized.language, history: prior, fallback: opts.fallbackLanguage });
    const merchantName = opts.merchantName !== undefined ? opts.merchantName : await merchantNameFor(workspaceId);
    const system = buildSystemBlocks({ language: opts.language, now: clock(), merchantName, detected: normalized.language });
    const claudeMessages = toClaudeHistory(prior, cfg.historyLimit, normalized.text);
    const state = { usage: emptyUsage(), toolCalls: [], writes: [], iterations: 0 };

    const finish = ({ reply, pendingAction = null, modelNote }) => {
      const at = clock();
      prior.push({ role: 'user', text: normalized.display, createdAt: at }, { role: 'assistant', text: reply, createdAt: at });
      session.pendingAction = pendingAction;
      const result = { reply, pendingAction, language, usage: usageView(state.usage), iterations: state.iterations, toolCalls: state.toolCalls };
      if (modelNote) result.modelNote = modelNote;
      return result;
    };
    const withWriteNote = (reply) => (state.writes.length ? `${reply}\n\n${writeNote(language, state.writes)}` : reply);

    // Validate, resolve what the ids point at, and build the confirmation card.
    // Anything wrong comes back as an error the model can act on.
    async function prepareProposal(block) {
      const prepared = bridge.prepareInput(block.name, block.input);
      if (!prepared.ok) return { error: `invalid arguments: ${prepared.error}` };
      const resolved = await summaries.resolveReferences({ toolName: block.name, args: prepared.args, workspaceId, lookups });
      if (resolved.problems.length) return { error: `cannot propose this action: ${resolved.problems.join('; ')}` };
      const card = await summaries.buildSummary({ toolName: block.name, args: prepared.args, language, lookups, workspaceId, resolved });
      const caution = hasActionIntent(block.name, normalized.text) ? '' : `\n\n${t(language, 'caution.noIntent')}`;
      return {
        pending: { id: crypto.randomUUID(), toolName: block.name, args: prepared.args, summary: `${card}${caution}`, createdAt: clock() },
      };
    }

    async function runReadBlock(block) {
      const tool = bridge.getTool(block.name);
      if (!tool) {
        state.toolCalls.push({ name: block.name, error: 'unknown tool' });
        return errorBlock(block.id, `Unknown tool: ${block.name}`);
      }
      const prepared = bridge.prepareInput(block.name, block.input);
      if (!prepared.ok) {
        state.toolCalls.push({ name: block.name, args: block.input, error: prepared.error });
        return errorBlock(block.id, `invalid arguments: ${prepared.error}`);
      }
      try {
        const result = await executeAction(tool, prepared.args, workspaceId, { confirmed: false });
        state.toolCalls.push({ name: block.name, args: prepared.args });
        if (!READ_TOOL_NAMES.includes(block.name)) state.writes.push(block.name);
        return toolResultBlock(block.id, serializeToolResult(result, cfg.maxToolResultChars));
      } catch (err) {
        const message = sanitizeErrorMessage(err && err.message);
        state.toolCalls.push({ name: block.name, args: prepared.args, error: message });
        return errorBlock(block.id, message);
      }
    }

    try {
      for (let i = 1; i <= cfg.maxIterations; i += 1) {
        state.iterations = i;
        const remaining = cfg.turnBudgetMs - (clock().getTime() - started);
        if (remaining <= 0) return finish({ reply: withWriteNote(t(language, 'reply.couldNotFinish')) });

        const response = await askModel({ system, messages: claudeMessages, timeoutMs: Math.min(cfg.requestTimeoutMs, remaining) });
        addUsage(state.usage, response && response.usage);
        const content = response && Array.isArray(response.content) ? response.content : [];
        const toolUses = content.filter((b) => b && b.type === 'tool_use');
        const text = joinText(content);

        // A cut-off response can hold a half-written tool call (a customer list
        // missing its tail): never act on it.
        if (response && response.stop_reason === 'max_tokens') {
          if (toolUses.length) return finish({ reply: withWriteNote(t(language, 'reply.tooLarge')) });
          return finish({ reply: text ? `${text}\n\n${t(language, 'reply.truncated')}` : t(language, 'reply.notSure') });
        }
        if (toolUses.length === 0) return finish({ reply: text || t(language, 'reply.notSure') });

        // STRUCTURAL GATE: tool.run() is not called for an action here.
        const actionBlock = toolUses.find((b) => bridge.isAction(b.name));
        let actionError = null;
        if (actionBlock) {
          const proposal = await prepareProposal(actionBlock);
          if (proposal.pending) {
            state.toolCalls.push({ name: actionBlock.name, args: proposal.pending.args, proposed: true });
            const note = text.length >= 12 && text !== proposal.pending.summary ? text.slice(0, MAX_MODEL_NOTE_LENGTH) : undefined;
            return finish({ reply: proposal.pending.summary, pendingAction: proposal.pending, modelNote: note });
          }
          actionError = proposal.error;
          state.toolCalls.push({ name: actionBlock.name, args: actionBlock.input, error: actionError, proposed: false });
        }
        if (i === cfg.maxIterations) return finish({ reply: withWriteNote(t(language, 'reply.couldNotFinish')) });

        // Every tool_use block needs a tool_result in the very next message, in order.
        claudeMessages.push({ role: 'assistant', content });
        const results = [];
        for (const block of toolUses) {
          if (bridge.isAction(block.name)) {
            const message = block === actionBlock ? actionError : 'Only one action can be proposed at a time. Nothing was run.';
            results.push(errorBlock(block.id, message));
          } else {
            results.push(await runReadBlock(block));
          }
        }
        claudeMessages.push({ role: 'user', content: results });
      }
      return finish({ reply: withWriteNote(t(language, 'reply.couldNotFinish')) });
    } catch (err) {
      // A draft may already exist (create_promotion / create_flow are un-gated).
      // Say so rather than surface a bare error the merchant will simply retry.
      if (state.writes.length) return finish({ reply: writeNote(language, state.writes) });
      throw err;
    }
  }

  // Confirm or decline the session's pending action. See the gate in the header.
  async function confirmAction(session, actionId, confirm, workspaceId, opts = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const pending = session && session.pendingAction;
    if (typeof actionId !== 'string' || !pending || pending.id !== actionId) throw actionNotPending();
    const language = resolveReplyLanguage({
      requested: opts.language,
      detected: detectLanguage(typeof pending.summary === 'string' ? pending.summary : '').language,
      history: session.messages,
      fallback: opts.fallbackLanguage,
    });

    // Claim FIRST (atomic when there is a store), then clear in memory.
    if (sessions && typeof sessions.claimPendingAction === 'function') {
      const won = await sessions.claimPendingAction({ sessionId: session.sessionId, workspaceId, actionId });
      if (!won) throw actionNotPending();
    }
    session.pendingAction = null;
    if (!Array.isArray(session.messages)) session.messages = [];

    const push = (reply) => {
      session.messages.push({ role: 'assistant', text: reply, createdAt: clock() });
      return reply;
    };

    if (confirm !== true) return { reply: push(t(language, 'reply.declined')), pendingAction: null, language, executed: false };

    let result;
    let args;
    try {
      const tool = bridge.getTool(pending.toolName);
      if (!tool || !tool.isAction) throw new Error(`Action tool no longer available: ${pending.toolName}`);
      // Stored arguments were validated when proposed; check them again in case
      // the registry changed since. Coercion is idempotent for valid input.
      const prepared = bridge.prepareInput(pending.toolName, pending.args);
      if (!prepared.ok) throw new Error(`Stored arguments are no longer valid: ${prepared.error}`);
      args = prepared.args;
      result = await executeAction(tool, args, workspaceId, { confirmed: true });
    } catch (err) {
      log('confirmed action failed:', pending.toolName, sanitizeErrorMessage(err && err.message));
      return { reply: push(summaries.describeError({ error: err, language })), pendingAction: null, language, executed: false };
    }
    // The action has happened. Describing it must never turn it into a reported failure.
    let reply;
    try {
      reply = summaries.describeResult({ toolName: pending.toolName, args, result, language });
    } catch (err) {
      log('could not describe the result of', pending.toolName, sanitizeErrorMessage(err && err.message));
      reply = t(language, 'result.generic');
    }
    return { reply: push(reply), pendingAction: null, language, executed: true };
  }

  return { runTurn, confirmAction, executeAction, config: cfg };
}

module.exports = {
  DEFAULTS,
  createAiModeAgent,
  executeAction,
  resolveReplyLanguage,
  toClaudeHistory,
  serializeToolResult,
  sanitizeErrorMessage,
};
