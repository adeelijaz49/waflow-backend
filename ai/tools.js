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
    run: (args, workspaceId) => ops.getOrderStats({ workspaceId }),
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
    run: async (args, workspaceId) => {
      const { customers, total } = await ops.listCustomers({ search: args.search, limit: args.limit || 20, workspaceId });
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
    run: (args, workspaceId) => ops.getCustomerReturnRate({ month: args.month, year: args.year, workspaceId }),
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
    run: (args, workspaceId) => ops.getTopLoyaltyCustomers({ limit: args.limit || 5, workspaceId }),
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
    run: (args, workspaceId) => ops.getBestPerformingPromotion({ metric: args.metric, limit: args.limit || 5, workspaceId }),
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
    run: (args, workspaceId) => ops.listInactiveCustomers({ days: args.days || 60, workspaceId }),
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
    run: async (args, workspaceId) => {
      const promos = await ops.listPromotions({ isDemo: args.isDemo, workspaceId });
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
    run: async (args, workspaceId) => {
      const flows = await ops.listFlows({ workspaceId });
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
    run: async (args, workspaceId) => {
      const { orders, total } = await ops.listOrders({ status: args.status, limit: args.limit || 20, workspaceId });
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
    run: (args, workspaceId) => ops.getCampaignReport({ promotionId: args.promotionId, workspaceId }),
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
    run: (args, workspaceId) => ops.getFlowReport({ flowId: args.flowId, workspaceId }),
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
    run: async (args, workspaceId) => {
      const recommended = await ops.getRecommendedCustomers({ promotionId: args.promotionId, limit: args.limit || 20, workspaceId });
      return recommended.slice(0, 20).map(c => ({
        id: c._id, name: `${c.firstname} ${c.lastname}`.trim(), phone: c.phone,
        loyaltyPoints: c.loyaltyPoints, segment: c.segment, orderCount: c.orderCount, totalSpent: c.totalSpent,
      }));
    },
  },

  // ── Action tools (Phase 3) ────────────────────────────────────────────────
  // create_promotion/create_flow are NOT gated: a new promotion starts in
  // 'draft' status and a new flow starts inactive — nothing external happens
  // until the separate, gated send_promotion/activate_flow tool runs.
  {
    name: 'create_promotion',
    description: 'Creates a new promotion in draft status — nothing is sent yet. Call this when the merchant wants to set up a new promotion. Follow up by proposing send_promotion once they confirm who to send it to.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Promotion name.' },
        description: { type: 'string' },
        scope: { type: 'string', enum: ['products', 'services'], description: 'Default products.' },
        customerType: { type: 'string', enum: ['cash', 'points'], description: 'Default cash.' },
        discountPercent: { type: 'number', description: 'For cash promotions, 0-100.' },
        pointsPrice: { type: 'number', description: 'For points promotions, points required per item.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    isAction: false,
    run: (args, workspaceId) => ops.createPromotion({
      name: args.name, description: args.description, scope: args.scope || 'products',
      customerType: args.customerType || 'cash', discountPercent: args.discountPercent, pointsPrice: args.pointsPrice,
      type: args.scope === 'services' ? 'specific_services' : 'store_wide',
      workspaceId,
    }),
  },
  {
    name: 'create_flow',
    description: 'Creates a new Automated Flow rule (a trigger condition that will message customers automatically once activated) — inactive until separately activated. Call this when the merchant wants to set up a new automation. Valid triggerType values: inactive_customer (win-back), post_purchase_points, points_balance_reminder, booking_no_show, points_threshold, purchase_frequency.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        triggerType: { type: 'string', enum: ['inactive_customer', 'post_purchase_points', 'points_balance_reminder', 'booking_no_show', 'points_threshold', 'purchase_frequency'] },
        promotionId: { type: 'string', description: 'Required for points_threshold/purchase_frequency; optional for the other trigger types (they have a fixed default message otherwise).' },
        inactivityDays: { type: 'integer' },
        delayHours: { type: 'integer' },
        pointsThreshold: { type: 'integer' },
        orderCountThreshold: { type: 'integer' },
      },
      required: ['name', 'triggerType'],
      additionalProperties: false,
    },
    isAction: false,
    run: (args, workspaceId) => ops.createFlow({
      name: args.name, triggerType: args.triggerType, promotionId: args.promotionId,
      inactivityDays: args.inactivityDays, delayHours: args.delayHours,
      pointsThreshold: args.pointsThreshold, orderCountThreshold: args.orderCountThreshold,
      workspaceId,
    }),
  },
  {
    name: 'send_promotion',
    description: 'Sends a real WhatsApp message for this promotion to the given customers right now. This messages real customers — always confirm the exact customer list and message with the merchant before calling this (the system will still require their explicit confirmation regardless).',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: { type: 'string' },
        customerIds: { type: 'array', items: { type: 'string' }, description: 'Customer ids to send to, from list_customers or get_recommended_customers.' },
      },
      required: ['promotionId', 'customerIds'],
      additionalProperties: false,
    },
    isAction: true,
    run: (args, workspaceId) => ops.sendPromotion({ promotionId: args.promotionId, customerIds: args.customerIds, workspaceId }),
  },
  {
    name: 'send_test_message',
    description: 'Sends one real test WhatsApp message for a promotion to a single phone number, so the merchant can see exactly what customers will receive.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: { type: 'string' },
        phone: { type: 'string', description: 'Phone number in international format, e.g. 966501234567.' },
      },
      required: ['promotionId', 'phone'],
      additionalProperties: false,
    },
    isAction: true,
    run: (args, workspaceId) => ops.sendTestMessage({ promotionId: args.promotionId, phone: args.phone, workspaceId }),
  },
  {
    name: 'send_loyalty_reminders',
    description: 'Sends a real WhatsApp loyalty-points reminder to customers with a points balance (or to a specific customer list if given).',
    input_schema: {
      type: 'object',
      properties: {
        customerIds: { type: 'array', items: { type: 'string' }, description: 'Optional — omit to send to every customer with a positive points balance.' },
      },
      additionalProperties: false,
    },
    isAction: true,
    run: (args, workspaceId) => ops.sendLoyaltyReminders({ customerIds: args.customerIds, workspaceId }),
  },
  {
    name: 'activate_flow',
    description: 'Activates an Automated Flow so it starts messaging qualifying customers going forward. Requires the flow\'s custom entry template (if any) to already be Meta-approved, or it falls back to the fixed default message.',
    input_schema: {
      type: 'object',
      properties: { flowId: { type: 'string' } },
      required: ['flowId'],
      additionalProperties: false,
    },
    isAction: true,
    run: (args, workspaceId) => ops.activateFlow({ id: args.flowId, workspaceId }),
  },
  {
    name: 'refund_order',
    description: 'Issues a real, irreversible Stripe refund for one paid order.',
    input_schema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
      additionalProperties: false,
    },
    isAction: true,
    run: (args, workspaceId) => ops.refundOrder({ id: args.orderId, workspaceId }),
  },
];

function getTool(name) {
  return TOOLS.find(t => t.name === name);
}

function toolsForClaude() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

module.exports = { TOOLS, getTool, toolsForClaude };
