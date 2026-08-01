const crypto = require('crypto');
const client = require('./client');
const { TOOLS, getTool, toolsForClaude } = require('./tools');

const MODEL = 'claude-sonnet-5';
const HISTORY_LIMIT = 20; // last ~10 turns sent per request — bounds token cost on long-lived sessions

const SYSTEM_PROMPT = `You are the AI assistant inside Waflow, a WhatsApp-commerce dashboard for a merchant.

You can do two kinds of things:
1. Answer questions about the merchant's real data (customers, orders, promotions, flows) using the read-only tools available to you. Answer directly in plain language — no confirmation needed, since nothing changes.
2. Propose actions that create or send something (a promotion, a flow, a message). You NEVER execute an action yourself — when you decide an action tool is the right one, call it and the system will show the merchant a confirmation prompt before anything actually happens. Explain what you're about to do in a short sentence before calling an action tool, so that sentence can double as the confirmation summary.

Never reuse an id (promotionId, customerId, flowId, orderId) from memory or from an earlier turn. Before calling any action tool, look the record up fresh in THIS turn (list_promotions, list_customers, etc.) and use the id from that fresh result — ids can be easy to mix up between similarly-named records, and sending the wrong one is a real, visible mistake to the merchant. The name you say out loud in your confirmation summary must be the name attached to the exact id you're about to send.

Be concise — this is a chat interface, not a report. Use real numbers from tool results, don't guess.`;

function toClaudeHistory(messages) {
  const recent = messages.slice(-HISTORY_LIMIT);
  return recent.map(m => ({ role: m.role, content: m.text }));
}

function askClaude(messages) {
  return client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    tools: toolsForClaude(),
    messages,
  });
}

async function runTurn(session, userMessage) {
  session.messages.push({ role: 'user', text: userMessage });
  session.pendingAction = null; // any previous pending action is implicitly superseded

  const claudeMessages = toClaudeHistory(session.messages);
  let response = await askClaude(claudeMessages);

  while (true) {
    // Claude can call several tools in parallel in one response — every
    // tool_use block here MUST get a matching tool_result in the very next
    // message, or the next request 400s ("tool_use ids were found without
    // tool_result blocks"). Never just grab the first block.
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlock = response.content.find(b => b.type === 'text');

    if (toolUseBlocks.length === 0) {
      const reply = textBlock?.text || "I'm not sure how to answer that — could you rephrase?";
      session.messages.push({ role: 'assistant', text: reply });
      return { reply, pendingAction: null };
    }

    // If any block is an action tool, stop the turn here and propose it.
    // Safe to return without resolving the other blocks in this response:
    // claudeMessages is only local to this request and is discarded on return.
    const actionBlock = toolUseBlocks.find(b => getTool(b.name)?.isAction);
    if (actionBlock) {
      // STRUCTURAL GATE: tool.run() is never called here. It's only reachable
      // from routes/aiChat.js's POST /confirm-action, after explicit user confirmation.
      const tool = getTool(actionBlock.name);
      const pendingAction = {
        id: crypto.randomUUID(),
        toolName: tool.name,
        args: actionBlock.input,
        summary: textBlock?.text || `I'll run ${tool.name} with ${JSON.stringify(actionBlock.input)}`,
        createdAt: new Date(),
      };
      session.pendingAction = pendingAction;
      session.messages.push({ role: 'assistant', text: pendingAction.summary });
      return { reply: pendingAction.summary, pendingAction };
    }

    // All read tools — run every one and return a tool_result for every
    // tool_use block, in the same order, so the pairing Claude requires holds.
    claudeMessages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const tool = getTool(block.name);
      if (!tool) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
        continue;
      }
      let result;
      try {
        result = await tool.run(block.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    claudeMessages.push({ role: 'user', content: toolResults });
    response = await askClaude(claudeMessages);
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
