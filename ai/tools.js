// Curated tool registry for the AI Mode chat agent (ai/agent.js). Deliberately
// separate from mcp/tools.js's 60 Zod-registered tools (which serve Claude.ai/
// ChatGPT as external connectors) — both are thin metadata wrappers over the
// same shared/operations.js functions, so business logic isn't duplicated even
// though tool descriptions are. See the AI Mode plan for the full rationale.
//
// isAction:true tools are never run from ai/agent.js's main loop — only from
// routes/aiChat.js's POST /confirm-action handler, after explicit user
// confirmation. That's the entire confirm-gate; see ai/agent.js.
const ops = require('../shared/operations');

const TOOLS = [
  {
    name: 'get_order_stats',
    description: 'Dashboard-style summary of the store: total orders, total customers, 30-day revenue, order status breakdown, repeat-customer count, campaign-attributed revenue, WhatsApp messages sent, loyalty points issued, conversion rate. Call this for broad "how is the store doing" or revenue/order-count questions.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    isAction: false,
    run: () => ops.getOrderStats(),
  },
  {
    name: 'list_customers',
    description: 'Search/list customers by name or phone, paginated. Call this for questions about specific customers or to browse the customer list. Returns each customer\'s order count and total spent.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional name or phone substring to filter by.' },
        limit: { type: 'integer', description: 'Max customers to return. Default 50, keep small (<=20) for a chat answer.' },
      },
      additionalProperties: false,
    },
    isAction: false,
    run: async (args) => {
      const { customers, total } = await ops.listCustomers({ search: args.search, limit: args.limit || 20 });
      return {
        total,
        customers: customers.map(c => ({
          id: c._id, name: `${c.firstname} ${c.lastname}`.trim(), phone: c.phone,
          loyaltyPoints: c.loyaltyPoints, orderCount: c.orderCount, totalSpent: c.totalSpent,
        })),
      };
    },
  },
];

function getTool(name) {
  return TOOLS.find(t => t.name === name);
}

function toolsForClaude() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

module.exports = { TOOLS, getTool, toolsForClaude };
