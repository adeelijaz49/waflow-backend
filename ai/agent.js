const crypto = require('crypto');
const client = require('./client');
const { TOOLS, getTool, toolsForClaude } = require('./tools');

const MODEL = 'claude-sonnet-5';
const HISTORY_LIMIT = 20; // last ~10 turns sent per request — bounds token cost on long-lived sessions

const SYSTEM_PROMPT = `You are the AI assistant inside Waflow, a WhatsApp-commerce dashboard for a merchant.

You can do two kinds of things:
1. Answer questions about the merchant's real data (customers, orders, promotions, flows) using the read-only tools available to you. Answer directly in plain language — no confirmation needed, since nothing changes.
2. Propose actions that create or send something (a promotion, a flow, a message). You NEVER execute an action yourself — when you decide an action tool is the right one, call it and the system will show the merchant a confirmation prompt before anything actually happens. Explain what you're about to do in a short sentence before calling an action tool, so that sentence can double as the confirmation summary.

Be concise — this is a chat interface, not a report. Use real numbers from tool results, don't guess.`;

function toClaudeHistory(messages) {
  const recent = messages.slice(-HISTORY_LIMIT);
  return recent.map(m => ({ role: m.role, content: m.text }));
}

async function runTurn(session, userMessage) {
  session.messages.push({ role: 'user', text: userMessage });
  session.pendingAction = null; // any previous pending action is implicitly superseded

  const claudeMessages = toClaudeHistory(session.messages);
  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    tools: toolsForClaude(),
    messages: claudeMessages,
  });

  while (true) {
    const toolUseBlock = response.content.find(b => b.type === 'tool_use');
    const textBlock = response.content.find(b => b.type === 'text');

    if (!toolUseBlock) {
      const reply = textBlock?.text || "I'm not sure how to answer that — could you rephrase?";
      session.messages.push({ role: 'assistant', text: reply });
      return { reply, pendingAction: null };
    }

    const tool = getTool(toolUseBlock.name);
    if (!tool) {
      // Unknown tool name — feed an error back so Claude can recover instead of crashing the turn.
      claudeMessages.push({ role: 'assistant', content: response.content });
      claudeMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: `Unknown tool: ${toolUseBlock.name}`, is_error: true }] });
      response = await client.messages.create({ model: MODEL, max_tokens: 4096, output_config: { effort: 'medium' }, system: SYSTEM_PROMPT, tools: toolsForClaude(), messages: claudeMessages });
      continue;
    }

    if (tool.isAction) {
      // STRUCTURAL GATE: tool.run() is never called here. It's only reachable
      // from routes/aiChat.js's POST /confirm-action, after explicit user confirmation.
      const pendingAction = {
        id: crypto.randomUUID(),
        toolName: tool.name,
        args: toolUseBlock.input,
        summary: textBlock?.text || `I'll run ${tool.name} with ${JSON.stringify(toolUseBlock.input)}`,
        createdAt: new Date(),
      };
      session.pendingAction = pendingAction;
      session.messages.push({ role: 'assistant', text: pendingAction.summary });
      return { reply: pendingAction.summary, pendingAction };
    }

    // Read tool — execute for real, feed the result back, continue the loop in this same request.
    let result;
    try {
      result = await tool.run(toolUseBlock.input);
    } catch (err) {
      result = { error: err.message };
    }
    claudeMessages.push({ role: 'assistant', content: response.content });
    claudeMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(result) }] });
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      tools: toolsForClaude(),
      messages: claudeMessages,
    });
  }
}

// One-off, tool-free completion so a raw tool result reads like a normal chat
// reply instead of dumped JSON. Falls back to the raw shape if this call fails
// for any reason — the merchant should never see an empty reply.
async function phraseResult(toolName, result) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: 'Describe this completed action result to the merchant in one short, plain-language sentence. No JSON, no code blocks, just the sentence.',
      messages: [{ role: 'user', content: `Tool: ${toolName}\nResult: ${JSON.stringify(result)}` }],
    });
    const text = response.content.find(b => b.type === 'text')?.text;
    return text || `Done. ${JSON.stringify(result)}`;
  } catch {
    return `Done. ${JSON.stringify(result)}`;
  }
}

async function confirmAction(session, actionId, confirm) {
  const pending = session.pendingAction;
  if (!pending || pending.id !== actionId) {
    const err = new Error('This action is no longer pending.');
    err.status = 409;
    throw err;
  }

  session.pendingAction = null;

  if (!confirm) {
    const reply = "No problem, I won't do that.";
    session.messages.push({ role: 'assistant', text: reply });
    return { reply, pendingAction: null };
  }

  const tool = getTool(pending.toolName);
  let reply;
  try {
    const result = await tool.run(pending.args);
    reply = await phraseResult(pending.toolName, result);
  } catch (err) {
    reply = `That didn't work: ${err.message}`;
  }
  session.messages.push({ role: 'assistant', text: reply });
  return { reply, pendingAction: null };
}

module.exports = { runTurn, confirmAction };
