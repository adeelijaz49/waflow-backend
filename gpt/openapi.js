const { APP_URL } = require('../utils/config');

// Built dynamically (not a static file) so the `servers` URL always matches
// wherever this is actually deployed, and edits here can't drift out of sync
// with gpt/routes.js without someone noticing at review time.
function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Waflow Store API',
      version: '1.0.0',
      description: 'Manage products, services, bookings, customers, orders, and promotions for the Waflow WhatsApp commerce store.',
    },
    servers: [{ url: `${APP_URL}/gpt-api` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/products': {
        get: {
          operationId: 'listProducts',
          summary: 'Search/list active products',
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          operationId: 'createProduct',
          summary: 'Create a new product',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['name', 'category', 'basePrice'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                category: { type: 'string' },
                basePrice: { type: 'number' },
                images: { type: 'array', items: { type: 'string' } },
                variants: { type: 'array', items: { type: 'object', properties: {
                  size: { type: 'string' }, color: { type: 'string' }, stock: { type: 'number' }, sku: { type: 'string' },
                } } },
              },
            } } },
          },
          responses: { 200: { description: 'Created' } },
        },
      },
      '/products/{id}': {
        get: {
          operationId: 'getProduct',
          summary: 'Fetch a single product by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          operationId: 'updateProduct',
          summary: 'Update fields on an existing product',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
              basePrice: { type: 'number' }, images: { type: 'array', items: { type: 'string' } },
            },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
      },
      '/products/{id}/deactivate': {
        post: {
          operationId: 'deactivateProduct',
          summary: 'Soft-delete a product (sets active: false)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },

      '/services': {
        get: {
          operationId: 'listServices',
          summary: 'List all active bookable services',
          responses: { 200: { description: 'OK' } },
        },
        post: {
          operationId: 'createService',
          summary: 'Create a new bookable service',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
              duration: { type: 'integer', description: 'minutes' }, basePrice: { type: 'number' },
              pointsPrice: { type: 'number' }, images: { type: 'array', items: { type: 'string' } },
            },
          } } } },
          responses: { 200: { description: 'Created' } },
        },
      },
      '/services/{id}': {
        get: {
          operationId: 'getService',
          summary: 'Fetch a service with its upcoming time slots and bookings',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          operationId: 'updateService',
          summary: 'Update fields on an existing service',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
              duration: { type: 'integer' }, basePrice: { type: 'number' }, pointsPrice: { type: 'number' },
              images: { type: 'array', items: { type: 'string' } },
            },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
      },
      '/services/{id}/deactivate': {
        post: {
          operationId: 'deactivateService',
          summary: 'Soft-delete a service (sets active: false)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/services/{id}/slots': {
        post: {
          operationId: 'createTimeSlot',
          summary: 'Add a bookable time slot to a service',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['date', 'startTime', 'endTime'],
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD' },
              startTime: { type: 'string', description: 'HH:MM' },
              endTime: { type: 'string', description: 'HH:MM' },
              capacity: { type: 'integer' },
            },
          } } } },
          responses: { 200: { description: 'Created' } },
        },
      },

      '/bookings': {
        get: {
          operationId: 'listBookings',
          summary: 'List bookings, optionally filtered to one service',
          parameters: [{ name: 'serviceId', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/bookings/{id}/cancel': {
        post: {
          operationId: 'cancelBooking',
          summary: 'Cancel a booking, free its slot, and message the customer a rebook link',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/bookings/{id}/reschedule': {
        post: {
          operationId: 'rescheduleBooking',
          summary: 'Move a booking to a different time slot and notify the customer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['newSlotId'], properties: { newSlotId: { type: 'string' } },
          } } } },
          responses: { 200: { description: 'OK' } },
        },
      },
      '/bookings/{id}/complete': {
        post: {
          operationId: 'completeBooking',
          summary: 'Mark a booking as completed',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/bookings/{id}/confirm': {
        post: {
          operationId: 'confirmBooking',
          summary: 'Approve a "requested" (Reserve, Pay in Person) booking and notify the customer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/bookings/{id}/decline': {
        post: {
          operationId: 'declineBooking',
          summary: 'Decline a "requested" (Reserve, Pay in Person) booking, free its slot, and notify the customer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/bookings/{id}/no-show': {
        post: {
          operationId: 'markNoShow',
          summary: 'Mark a confirmed booking as a no-show (manual, after the fact)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },

      '/customers': {
        get: {
          operationId: 'listCustomers',
          summary: 'Search/list customers with pagination and order stats',
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'isDemo', in: 'query', schema: { type: 'boolean' } },
            { name: 'page', in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          operationId: 'createCustomer',
          summary: 'Create a new customer record',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['firstname', 'lastname', 'phone'],
            properties: {
              firstname: { type: 'string' }, lastname: { type: 'string' }, phone: { type: 'string' },
              email: { type: 'string' }, address: { type: 'string' },
            },
          } } } },
          responses: { 200: { description: 'Created' } },
        },
      },
      '/customers/{id}': {
        get: {
          operationId: 'getCustomer',
          summary: 'Fetch a customer with their order history',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          operationId: 'updateCustomer',
          summary: 'Update fields on an existing customer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              firstname: { type: 'string' }, lastname: { type: 'string' }, phone: { type: 'string' },
              email: { type: 'string' }, address: { type: 'string' }, loyaltyPoints: { type: 'number' },
            },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
      },
      '/customers/{id}/whatsapp-history': {
        get: {
          operationId: 'getCustomerWhatsAppHistory',
          summary: 'Timeline of promotional sends, loyalty reminders, and booking notifications sent to this customer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/customers/{id}/bookings': {
        get: {
          operationId: 'getCustomerBookings',
          summary: "List a customer's service bookings",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },

      '/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'List orders, optionally filtered by status',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'source', in: 'query', schema: { type: 'string', enum: ['campaign', 'manual', 'booking', 'product'] } },
            { name: 'page', in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          operationId: 'createOrder',
          summary: 'Place an order and send the customer a Stripe payment link on WhatsApp. Does NOT charge any card directly.',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['customerId', 'items'],
            properties: {
              customerId: { type: 'string' },
              items: { type: 'array', items: { type: 'object', required: ['productId'], properties: {
                productId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 },
              } } },
              shippingAddress: { type: 'string', description: 'Optional. Uses the address on file if omitted.' },
            },
          } } } },
          responses: { 200: { description: 'Order created, payment link sent' } },
        },
      },
      '/orders/stats': {
        get: {
          operationId: 'getOrderStats',
          summary: 'Dashboard-style summary: totals, 30-day revenue, status breakdown, recent orders',
          responses: { 200: { description: 'OK' } },
        },
      },
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          summary: 'Fetch a single order by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/orders/{id}/status': {
        patch: {
          operationId: 'updateOrderStatus',
          summary: 'Change an order\'s status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] } },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
      },
      '/orders/{id}/refund': {
        post: {
          operationId: 'refundOrder',
          summary: 'Issue a real Stripe refund for a paid order and mark it refunded. Irreversible — only works on orders with paymentStatus "paid".',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Refunded' } },
        },
      },

      '/payments/{paymentIntentId}': {
        get: {
          operationId: 'getPaymentStatus',
          summary: 'Check whether a payment intent created by createOrder has been paid yet',
          parameters: [{ name: 'paymentIntentId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },

      '/promotions': {
        get: {
          operationId: 'listPromotions',
          summary: 'List all promotions (product and service)',
          parameters: [{ name: 'isDemo', in: 'query', schema: { type: 'boolean' } }],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          operationId: 'createPromotion',
          summary: 'Create a new promotion (draft)',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' }, description: { type: 'string' },
              customerType: { type: 'string', enum: ['cash', 'points'] },
              scope: { type: 'string', enum: ['products', 'services'] },
              type: { type: 'string', enum: ['specific_products', 'store_wide', 'specific_services'] },
              campaignType: { type: 'string', enum: ['product_promotion', 'service_booking_campaign', 'loyalty_reminder', 'inactive_customer_comeback', 'store_wide_offer'] },
              productIds: { type: 'array', items: { type: 'string' } },
              serviceIds: { type: 'array', items: { type: 'string' } },
              discountPercent: { type: 'number', minimum: 0, maximum: 100 },
              pointsPrice: { type: 'number' },
              startDate: { type: 'string' }, endDate: { type: 'string' },
            },
          } } } },
          responses: { 200: { description: 'Created' } },
        },
      },
      '/promotions/{id}': {
        get: {
          operationId: 'getPromotion',
          summary: 'Fetch a single promotion by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          operationId: 'updatePromotion',
          summary: 'Update fields on an existing promotion',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              name: { type: 'string' }, description: { type: 'string' },
              campaignType: { type: 'string', enum: ['product_promotion', 'service_booking_campaign', 'loyalty_reminder', 'inactive_customer_comeback', 'store_wide_offer'] },
              discountPercent: { type: 'number' }, pointsPrice: { type: 'number' },
              status: { type: 'string', enum: ['draft', 'active', 'expired'] },
              startDate: { type: 'string' }, endDate: { type: 'string' },
              productIds: { type: 'array', items: { type: 'string' } },
              serviceIds: { type: 'array', items: { type: 'string' } },
            },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
        delete: {
          operationId: 'deletePromotion',
          summary: 'Permanently delete a promotion',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/promotions/{id}/recommended-customers': {
        get: {
          operationId: 'getRecommendedCustomers',
          summary: 'RFM-scored customer recommendations for targeting a promotion send',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/promotions/{id}/send': {
        post: {
          operationId: 'sendPromotion',
          summary: 'Send a real WhatsApp message to the given customers for this promotion. Confirm scope with the user before calling.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['customerIds'], properties: { customerIds: { type: 'array', items: { type: 'string' } } },
          } } } },
          responses: { 200: { description: 'Sent' } },
        },
      },

      '/promotions/{id}/report': {
        get: {
          operationId: 'getCampaignReport',
          summary: 'Funnel report for a sent promotion: messages sent/delivered/read/failed, clicks, orders created, revenue, points issued, conversion rate.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },

      '/promotions/{id}/preview': {
        get: {
          operationId: 'previewPromotionMessage',
          summary: 'Returns the exact WhatsApp message a customer would receive for this promotion, without sending anything.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/promotions/{id}/test-send': {
        post: {
          operationId: 'sendTestMessage',
          summary: 'Sends the real promotion message to one phone number for testing. Confirm the number with the user before calling — this is a real send.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['phone'], properties: { phone: { type: 'string' } },
          } } } },
          responses: { 200: { description: 'Sent' } },
        },
      },

      '/loyalty/remind': {
        post: {
          operationId: 'sendLoyaltyReminders',
          summary: 'Message real customers reminding them of their loyalty points balance. Omit customerIds to target everyone with points > 0.',
          requestBody: { content: { 'application/json': { schema: {
            type: 'object', properties: { customerIds: { type: 'array', items: { type: 'string' } } },
          } } } },
          responses: { 200: { description: 'Sent' } },
        },
      },

      '/flows': {
        get: {
          operationId: 'listFlows',
          summary: 'List automated lifecycle-messaging flows',
          parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'paused'] } }],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          operationId: 'createFlow',
          summary: 'Create a new automated flow (starts paused). Supported triggerTypes: inactive_customer, post_purchase_points, points_balance_reminder, booking_no_show.',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: ['name', 'triggerType'],
            properties: {
              name: { type: 'string' },
              triggerType: { type: 'string', enum: ['inactive_customer', 'post_purchase_points', 'points_balance_reminder', 'booking_no_show'] },
              inactivityDays: { type: 'integer' },
              delayHours: { type: 'number' },
              cooldownDaysOverride: { type: 'number' },
            },
          } } } },
          responses: { 200: { description: 'Created' } },
        },
      },
      '/flows/{id}': {
        get: {
          operationId: 'getFlow',
          summary: 'Fetch a single flow by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          operationId: 'updateFlow',
          summary: 'Update a flow\'s name/config. triggerType cannot be changed after creation.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              inactivityDays: { type: 'integer' },
              delayHours: { type: 'number' },
              cooldownDaysOverride: { type: 'number' },
            },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
        delete: {
          operationId: 'deleteFlow',
          summary: 'Permanently delete a flow',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/flows/{id}/activate': {
        post: {
          operationId: 'activateFlow',
          summary: 'Turn a flow on. It will begin enrolling and messaging eligible customers on the next scheduler tick — results in real WhatsApp sends over time. Confirm with the merchant before calling.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/flows/{id}/pause': {
        post: {
          operationId: 'pauseFlow',
          summary: 'Turn a flow off. Stops new enrollments and sends, keeps all history.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/flows/{id}/enrollments': {
        get: {
          operationId: 'listFlowEnrollments',
          summary: 'List the customers a flow has enrolled, with their state (enrolled/messaged/exited/completed)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/flows/{id}/report': {
        get: {
          operationId: 'getFlowReport',
          summary: 'Funnel report for a flow: enrolled/messaged/exited/completed counts, messages sent/delivered/read/failed, clicks, orders created, revenue, points issued, conversion rate.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },

      '/settings/loyalty': {
        get: {
          operationId: 'getLoyaltySettings',
          summary: 'Fetch the loyalty program configuration',
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          operationId: 'updateLoyaltySettings',
          summary: 'Update the loyalty program configuration',
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              loyaltyPointsPerUnit: { type: 'number' }, minPointsPerPurchase: { type: 'number' }, currency: { type: 'string' },
            },
          } } } },
          responses: { 200: { description: 'Updated' } },
        },
      },
    },
  };
}

module.exports = { buildOpenApiSpec };
