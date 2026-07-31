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
  {
    name: 'get_customer_return_rate',
    description: 'How many customers returned (placed another order) in a given month, vs how many customers ordered that month in total. Call this for "how many customers came back this month" style questions. Defaults to the current month if not specified.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'integer', description: '1-12. Defaults to the current month.' },
        year: { type: 'integer', description: 'e.g. 2026. Defaults to the current year.' },
      },
      additionalProperties: false,
    },
    isAction: false,
    run: (args) => ops.getCustomerReturnRate({ month: args.month, year: args.year }),
  },
  {
    name: 'get_top_loyalty_customers',
    description: 'Ranks customers by loyalty points balance, highest first. Call this for "which customer has the most points" style questions.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max customers to return. Default 5.' } },
      additionalProperties: false,
    },
    isAction: false,
    run: (args) => ops.getTopLoyaltyCustomers({ limit: args.limit || 5 }),
  },
  {
    name: 'get_best_performing_promotion',
    description: 'Ranks all promotions by a performance metric (revenue by default) using their real send/click/order data. Call this for "which promotion performed best" style questions.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['revenue', 'ordered', 'conversionRate'], description: 'What to rank by. Default revenue.' },
        limit: { type: 'integer', description: 'Max promotions to return. Default 5.' },
      },
      additionalProperties: false,
    },
    isAction: false,
    run: (args) => ops.getBestPerformingPromotion({ metric: args.metric, limit: args.limit || 5 }),
  },
  {
    name: 'list_inactive_customers',
    description: 'Lists customers who haven\'t placed an order in over N days (default 60). Call this for "who hasn\'t ordered in a while" style questions.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Inactivity threshold in days. Default 60.' } },
      additionalProperties: false,
    },
    isAction: false,
    run: (args) => ops.listInactiveCustomers({ days: args.days || 60 }),
  },
  {
    name: 'list_promotions',
    description: 'Lists promotions (name, discount/points, scope, status, sent count). Call this to browse or look up existing promotions by name.',
    input_schema: {
      type: 'object',
      properties: { isDemo: { type: 'boolean', description: 'Filter to demo-only or real-only promotions. Omit for all.' } },
      additionalProperties: false,
    },
    isAction: false,
    run: async (args) => {
      const promos = await ops.listPromotions({ isDemo: args.isDemo });
      return promos.slice(0, 20).map(p => ({
        id: p._id, name: p.name, status: p.status, scope: p.scope, customerType: p.customerType,
        discountPercent: p.discountPercent, pointsPrice: p.pointsPrice, sentCount: p.sentCount,
      }));
    },
  },
  {
    name: 'list_flows',
    description: 'Lists Automated Flows (name, trigger type, status). Call this to browse or look up existing flows by name.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    isAction: false,
    run: async () => {
      const flows = await ops.listFlows();
      return flows.slice(0, 20).map(f => ({
        id: f._id, name: f.name, triggerType: f.triggerType, status: f.status,
        promotionName: f.promotionId?.name || null,
      }));
    },
  },
  {
    name: 'list_orders',
    description: 'Lists recent orders (customer, total, status, date), optionally filtered by status. Call this for order-related questions like "how many orders came in last week" (check createdAt on the results) or to browse recent orders.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional order status filter, e.g. pending, confirmed, cancelled.' },
        limit: { type: 'integer', description: 'Max orders to return. Default 20.' },
      },
      additionalProperties: false,
    },
    isAction: false,
    run: async (args) => {
      const { orders, total } = await ops.listOrders({ status: args.status, limit: args.limit || 20 });
      return {
        total,
        orders: orders.map(o => ({
          id: o._id, customerName: o.customer ? `${o.customer.firstname || ''} ${o.customer.lastname || ''}`.trim() : null,
          total: o.total, status: o.status, createdAt: o.createdAt,
        })),
      };
    },
  },
  {
    name: 'get_campaign_report',
    description: 'Funnel report for one promotion by id: sent/delivered/read/clicked/ordered, revenue, points issued, conversion rate. Call this after list_promotions has identified which promotion the merchant means.',
    input_schema: {
      type: 'object',
      properties: { promotionId: { type: 'string', description: 'The promotion\'s id, from list_promotions.' } },
      required: ['promotionId'],
      additionalProperties: false,
    },
    isAction: false,
    run: (args) => ops.getCampaignReport({ promotionId: args.promotionId }),
  },
  {
    name: 'get_flow_report',
    description: 'Funnel report for one Automated Flow by id: sent/delivered/read/clicked/ordered, revenue, points issued, conversion rate. Call this after list_flows has identified which flow the merchant means.',
    input_schema: {
      type: 'object',
      properties: { flowId: { type: 'string', description: 'The flow\'s id, from list_flows.' } },
      required: ['flowId'],
      additionalProperties: false,
    },
    isAction: false,
    run: (args) => ops.getFlowReport({ flowId: args.flowId }),
  },
  {
    name: 'get_recommended_customers',
    description: 'RFM-ranked (recency/frequency/monetary) list of customers best suited for a specific promotion, tailored to its scope/products/category. Requires a real promotionId — call list_promotions first if you don\'t already have it. Call this when the merchant wants to know who to target for a promotion, before proposing a send.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: { type: 'string', description: 'The promotion\'s id, from list_promotions.' },
        limit: { type: 'integer', description: 'Max customers to return. Default 20.' },
      },
      required: ['promotionId'],
      additionalProperties: false,
    },
    isAction: false,
    run: async (args) => {
      const recommended = await ops.getRecommendedCustomers({ promotionId: args.promotionId, limit: args.limit || 20 });
      return recommended.slice(0, 20).map(c => ({
        id: c._id, name: `${c.firstname} ${c.lastname}`.trim(), phone: c.phone,
        loyaltyPoints: c.loyaltyPoints, segment: c.segment, orderCount: c.orderCount, totalSpent: c.totalSpent,
      }));
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
