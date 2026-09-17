// WhatsApp Inbox — a merchant-facing view over WhatsApp conversations that
// merges three existing collections (CampaignMessage, Order, Booking) with
// one new one (WhatsAppMessage, for inbound messages and manual outbound
// replies) into a single per-customer timeline. Deliberately reads the
// existing collections rather than duplicating their data into
// WhatsAppMessage — CampaignMessage/Order/Booking already carry everything
// needed to describe a campaign/order/booking event in the thread, and this
// keeps the new model additive instead of a second source of truth.
//
// Used by routes/inbox.js (the dashboard) and hooked into server.js's
// WhatsApp webhook handler at exactly two points: logging an inbound
// message, and applying delivery/read status callbacks to manual sends.

const Stripe = require('stripe');

const Customer         = require('../models/Customer');
const Order            = require('../models/Order');
const Booking          = require('../models/Booking');
const CampaignMessage  = require('../models/CampaignMessage');
const WhatsAppMessage  = require('../models/WhatsAppMessage');
const { waPost }       = require('../utils/whatsapp');
const { APP_URL }      = require('../utils/config');
const { money }        = require('../utils/currency');
const { getCurrency }  = require('../utils/settingsCache');
const { withWorkspace, scopedFilter, workspaceMatch } = require('./operations');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Tag thresholds (simple, documented heuristics for MVP — not the RFM
// scoring used by Promotions targeting; see shared/operations.js#segmentFor
// for that separate, more elaborate model) ──────────────────────────────────
const HIGH_VALUE_MIN_SPEND  = 200; // flat spend threshold, in the workspace's configured currency
const HIGH_VALUE_MIN_ORDERS = 5;
const INACTIVE_DAYS         = 60;  // matches shared/operations.js#listInactiveCustomers' existing convention
const RECENT_BUYER_DAYS     = 14;
const NO_ORDER_NUDGE_DAYS   = 30;  // the softer "hasn't ordered in 30 days" commercial prompt

function wamidOf(sendResult) {
  return sendResult?.messages?.[0]?.id;
}

function daysSince(date) {
  return date ? (Date.now() - new Date(date).getTime()) / 86400000 : null;
}

function customerName(c) {
  return `${c.firstname || ''} ${c.lastname || ''}`.trim() || c.phone;
}

function computeTags({ customer, orderCount = 0, totalSpent = 0, lastOrderAt, hasBooking }) {
  const tags = [];
  const sinceOrder = daysSince(lastOrderAt);
  if (totalSpent >= HIGH_VALUE_MIN_SPEND || orderCount >= HIGH_VALUE_MIN_ORDERS) tags.push('High-value');
  if (sinceOrder !== null && sinceOrder >= INACTIVE_DAYS) tags.push('Inactive');
  if (customer.loyaltyPoints > 0) tags.push('Loyalty member');
  if (sinceOrder !== null && sinceOrder <= RECENT_BUYER_DAYS) tags.push('Recent buyer');
  if (hasBooking) tags.push('Booking customer');
  return tags;
}

// ─── Inbound message content ─────────────────────────────────────────────────

function extractInboundContent(message) {
  switch (message.type) {
    case 'text':     return message.text?.body || '';
    case 'button':   return message.button?.text ? `↩️ ${message.button.text}` : '[Button tap]';
    case 'interactive': {
      const ir = message.interactive || {};
      if (ir.type === 'button_reply') return `↩️ ${ir.button_reply?.title || 'Button tap'}`;
      if (ir.type === 'list_reply')   return `↩️ ${ir.list_reply?.title || 'Selection'}`;
      return '[Interactive reply]';
    }
    case 'image':    return message.image?.caption || '📷 Photo';
    case 'video':    return message.video?.caption || '🎥 Video';
    case 'document': return message.document?.caption || `📄 ${message.document?.filename || 'Document'}`;
    case 'audio':    return '🎤 Voice message';
    case 'sticker':  return '🎨 Sticker';
    case 'location': return '📍 Location shared';
    default:         return `[${message.type || 'message'}]`;
  }
}

// ─── Webhook integration points (called from server.js) ─────────────────────

// Persists an inbound WhatsApp message and refreshes the customer's
// conversation summary. Auto-creates the customer profile when the sender
// isn't known yet, per spec: "If the customer does not exist, create/update
// the customer profile automatically." Idempotent on message.id (wamid) so a
// Meta webhook redelivery never double-counts the unread badge.
async function logInboundMessage({ workspaceId, from, message, contactName }) {
  if (!workspaceId || !from || !message) return;

  let customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
  if (!customer) {
    const [firstname, ...rest] = (contactName || from).trim().split(/\s+/);
    customer = await Customer.create({
      workspaceId, phone: from,
      firstname: firstname || from,
      lastname: rest.join(' '),
    });
  }

  const body = extractInboundContent(message);

  try {
    await WhatsAppMessage.create({
      workspaceId, customer: customer._id, phone: from,
      direction: 'inbound', messageType: 'manual',
      messageBody: body, wamid: message.id,
      deliveryStatus: 'delivered', receivedAt: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) return; // duplicate wamid — already logged, skip the unread bump too
    throw err;
  }

  await Customer.findByIdAndUpdate(customer._id, {
    $inc: { unreadCount: 1 },
    $set: { lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 140), conversationStatus: 'open' },
  });
}

// Rank for monotonic status updates — mirrors server.js's own STATUS_RANK for
// CampaignMessage, kept as a separate small copy here rather than importing
// a private constant out of server.js.
const STATUS_RANK = { queued: 0, sent: 1, failed: 1, delivered: 2, read: 3 };

// Applies one WhatsApp status callback entry to the matching WhatsAppMessage
// (manual sends only — CampaignMessage handles its own sends' statuses
// separately in server.js, unchanged). No-ops silently if no manual send
// with this wamid exists, which is the common case for every other
// (campaign/loyalty/booking) outbound message type.
async function updateMessageStatus(status, workspaceId) {
  const msg = await WhatsAppMessage.findOne(withWorkspace({ wamid: status.id }, workspaceId));
  if (!msg) return;
  if ((STATUS_RANK[status.status] ?? 0) < (STATUS_RANK[msg.deliveryStatus] ?? 0)) return;

  const update = { deliveryStatus: status.status };
  if (status.status === 'failed') update.statusReason = status.errors?.[0]?.title || status.errors?.[0]?.message;
  await WhatsAppMessage.findByIdAndUpdate(msg._id, update);
}

// ─── Conversation list (left panel) ──────────────────────────────────────────

async function listConversations({ workspaceId, filter, search } = {}) {
  const custFilter = withWorkspace({ deletedAt: { $exists: false }, isDemo: { $ne: true } }, workspaceId);
  if (search) {
    custFilter.$or = [
      { firstname: { $regex: search, $options: 'i' } },
      { lastname: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }

  const [customers, orderStats, bookingStats, campaignStats, bookingCustomerIds] = await Promise.all([
    Customer.find(custFilter).lean(),
    Order.aggregate([
      { $match: workspaceMatch(workspaceId) },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: '$customer', orderCount: { $sum: 1 }, totalSpent: { $sum: '$total' },
        lastOrderAt: { $first: '$createdAt' }, lastOrderItemCount: { $first: { $size: { $ifNull: ['$items', []] } } },
      } },
    ]),
    Booking.aggregate([
      { $match: workspaceMatch(workspaceId) },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$customerId', lastBookingAt: { $first: '$createdAt' }, lastBookingStatus: { $first: '$status' } } },
    ]),
    CampaignMessage.aggregate([
      { $match: workspaceMatch(workspaceId) },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$customer', lastCampaignAt: { $first: '$createdAt' }, lastKind: { $first: '$kind' } } },
    ]),
    Booking.distinct('customerId', withWorkspace({}, workspaceId)),
  ]);

  const orderMap    = new Map(orderStats.map(s => [s._id?.toString(), s]));
  const bookingMap  = new Map(bookingStats.map(s => [s._id?.toString(), s]));
  const campaignMap = new Map(campaignStats.map(s => [s._id?.toString(), s]));
  const bookingCustomerSet = new Set(bookingCustomerIds.map(id => id?.toString()));

  const kindPreview = { promotion: '📣 Promotion sent', loyalty_reminder: '💎 Loyalty reminder sent', booking_notification: '📅 Booking update sent', flow: '🔁 Automated message sent', consent_request: '🔔 Consent request sent' };

  let rows = customers.map(c => {
    const id = c._id.toString();
    const o = orderMap.get(id);
    const b = bookingMap.get(id);
    const cm = campaignMap.get(id);

    // Prefer a real logged WhatsApp message; otherwise fall back to whichever
    // existing record (order/booking/campaign) is most recent, so a customer
    // with real history shows up usefully even before the Inbox starts
    // logging real conversations of its own.
    const candidates = [
      c.lastMessageAt ? { at: c.lastMessageAt, preview: c.lastMessagePreview } : null,
      o ? { at: o.lastOrderAt, preview: `🛍️ Order placed — ${o.lastOrderItemCount} item(s)` } : null,
      b ? { at: b.lastBookingAt, preview: `📅 Booking ${b.lastBookingStatus}` } : null,
      cm ? { at: cm.lastCampaignAt, preview: kindPreview[cm.lastKind] || '📣 Campaign message sent' } : null,
    ].filter(Boolean);
    candidates.sort((x, y) => new Date(y.at) - new Date(x.at));
    const latest = candidates[0];

    const tags = computeTags({
      customer: c, orderCount: o?.orderCount || 0, totalSpent: o?.totalSpent || 0,
      lastOrderAt: o?.lastOrderAt, hasBooking: bookingCustomerSet.has(id),
    });

    return {
      customerId: c._id,
      name: customerName(c),
      phone: c.phone,
      optedOut: c.optedOut,
      unreadCount: c.unreadCount || 0,
      lastMessageAt: latest?.at || null,
      lastMessagePreview: latest?.preview || null,
      tags,
    };
  });

  rows = rows.filter(r => r.lastMessageAt); // only customers with some conversation-worthy activity

  if (filter === 'unread')      rows = rows.filter(r => r.unreadCount > 0);
  else if (filter === 'high-value') rows = rows.filter(r => r.tags.includes('High-value'));
  else if (filter === 'inactive')   rows = rows.filter(r => r.tags.includes('Inactive'));
  else if (filter === 'recent')     rows = rows.filter(r => r.tags.includes('Recent buyer'));
  else if (filter === 'booking')    rows = rows.filter(r => r.tags.includes('Booking customer'));

  rows.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  return { conversations: rows };
}

// ─── Conversation thread (centre panel) ──────────────────────────────────────

async function getThread({ customerId, workspaceId }) {
  const customer = await Customer.findOne(scopedFilter(customerId, workspaceId));
  if (!customer) throw new Error('Customer not found');

  await Customer.findByIdAndUpdate(customer._id, { unreadCount: 0 });

  const currency = await getCurrency();
  const [waMessages, campaignMessages, orders, bookings] = await Promise.all([
    WhatsAppMessage.find(withWorkspace({ customer: customer._id }, workspaceId)).sort({ createdAt: 1 }).lean(),
    CampaignMessage.find(withWorkspace({ customer: customer._id }, workspaceId)).sort({ createdAt: 1 }).populate('promotion', 'name').lean(),
    Order.find(withWorkspace({ customer: customer._id }, workspaceId)).sort({ createdAt: 1 }).lean(),
    Booking.find(withWorkspace({ customerId: customer._id }, workspaceId)).sort({ createdAt: 1 }).populate('serviceId', 'name').populate('slotId', 'date startTime').lean(),
  ]);

  const kindLabel = { promotion: '📣 Promotion', loyalty_reminder: '💎 Loyalty reminder', booking_notification: '📅 Booking update', flow: '🔁 Automated message', consent_request: '🔔 Consent request' };
  const kindType  = { promotion: 'campaign', loyalty_reminder: 'loyalty', booking_notification: 'booking', flow: 'campaign', consent_request: 'campaign' };

  const timeline = [];

  for (const m of waMessages) {
    timeline.push({
      id: m._id, direction: m.direction, messageType: m.messageType,
      body: m.messageBody, mediaUrl: m.mediaUrl,
      status: m.deliveryStatus, timestamp: m.sentAt || m.receivedAt || m.createdAt,
    });
  }

  for (const cm of campaignMessages) {
    timeline.push({
      id: cm._id, direction: 'outbound', messageType: kindType[cm.kind] || 'campaign',
      body: `${kindLabel[cm.kind] || '📣 Campaign message'}${cm.promotion?.name ? ' — ' + cm.promotion.name : ''}`,
      status: cm.status, timestamp: cm.sentAt || cm.createdAt,
      meta: { clicked: !!cm.clickedAt },
    });
  }

  for (const o of orders) {
    timeline.push({
      id: `${o._id}-order`, direction: 'outbound', messageType: 'order',
      body: `🛍️ Order confirmed — ${o.items?.length || 0} item(s) · ${money(o.total || 0, currency)}`,
      status: o.status, timestamp: o.createdAt, meta: { orderId: o._id },
    });
    if (o.paymentStatus && o.paymentStatus !== 'pending') {
      timeline.push({
        id: `${o._id}-payment`, direction: 'outbound', messageType: 'payment',
        body: `💳 Payment ${o.paymentStatus} — ${money(o.total || 0, currency)}`,
        status: o.paymentStatus, timestamp: o.paidAt || o.createdAt, meta: { orderId: o._id },
      });
    }
  }

  for (const b of bookings) {
    const when = b.slotId ? ` on ${b.slotId.date} at ${b.slotId.startTime}` : '';
    timeline.push({
      id: `${b._id}-booking`, direction: 'outbound', messageType: 'booking',
      body: `📅 Booking ${b.status} — ${b.serviceId?.name || 'Service'}${when}`,
      status: b.status, timestamp: b.createdAt, meta: { bookingId: b._id },
    });
  }

  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return {
    customer: {
      _id: customer._id, name: customerName(customer), phone: customer.phone,
      optedOut: customer.optedOut, conversationStatus: customer.conversationStatus,
    },
    messages: timeline,
  };
}

// ─── Customer snapshot (right panel) ─────────────────────────────────────────

async function getSnapshot({ customerId, workspaceId }) {
  const customer = await Customer.findOne(scopedFilter(customerId, workspaceId)).lean();
  if (!customer) throw new Error('Customer not found');

  const [orders, bookings, lastCampaign] = await Promise.all([
    Order.find(withWorkspace({ customer: customer._id }, workspaceId)).sort({ createdAt: -1 }).lean(),
    Booking.find(withWorkspace({ customerId: customer._id }, workspaceId)).sort({ createdAt: -1 }).populate('serviceId', 'name').populate('slotId', 'date startTime').lean(),
    CampaignMessage.findOne(withWorkspace({ customer: customer._id }, workspaceId)).sort({ createdAt: -1 }).populate('promotion', 'name').lean(),
  ]);

  const totalOrders = orders.length;
  const totalSpent  = orders.reduce((s, o) => s + (o.total || 0), 0);
  const lastOrder   = orders[0] || null;

  const productsPurchased = (() => {
    const byName = new Map();
    for (const o of orders) {
      const seen = new Set();
      for (const item of o.items || []) {
        const name = item.productName || 'Unknown item';
        const entry = byName.get(name) || { name, quantity: 0, orders: 0 };
        entry.quantity += item.quantity || 1;
        if (!seen.has(name)) { entry.orders += 1; seen.add(name); }
        byName.set(name, entry);
      }
    }
    return [...byName.values()].sort((a, b) => b.quantity - a.quantity);
  })();

  const servicesBooked = bookings.map(b => ({
    name: b.serviceId?.name || 'Service', status: b.status,
    date: b.slotId?.date || null, startTime: b.slotId?.startTime || null,
  }));

  const tags = computeTags({
    customer, orderCount: totalOrders, totalSpent, lastOrderAt: lastOrder?.createdAt,
    hasBooking: bookings.length > 0,
  });

  const prompts = [];
  const sinceOrder = daysSince(lastOrder?.createdAt);
  if (sinceOrder !== null && sinceOrder >= NO_ORDER_NUDGE_DAYS) prompts.push(`This customer has not ordered in ${Math.floor(sinceOrder)} days.`);
  if (customer.loyaltyPoints > 0) prompts.push(`This customer has ${customer.loyaltyPoints} unused loyalty points.`);
  if (lastCampaign?.clickedAt) prompts.push('This customer responded to the last campaign.');
  if (tags.includes('High-value')) prompts.push('This customer is high-value.');

  return {
    customer: {
      _id: customer._id, name: customerName(customer), phone: customer.phone,
      optedOut: customer.optedOut, optedOutAt: customer.optedOutAt,
      marketingConsent: customer.marketingConsent, marketingConsentAt: customer.marketingConsentAt,
      loyaltyPoints: customer.loyaltyPoints || 0,
      createdAt: customer.createdAt,
    },
    totalOrders, totalSpent,
    lastOrder: lastOrder ? { _id: lastOrder._id, total: lastOrder.total, status: lastOrder.status, paymentStatus: lastOrder.paymentStatus, createdAt: lastOrder.createdAt } : null,
    lastCampaign: lastCampaign ? { kind: lastCampaign.kind, promotionName: lastCampaign.promotion?.name || null, status: lastCampaign.status, sentAt: lastCampaign.sentAt || lastCampaign.createdAt } : null,
    productsPurchased, servicesBooked, tags, prompts,
  };
}

// ─── Sending ──────────────────────────────────────────────────────────────────

// Manual, free-form message from the inbox composer — a session/utility
// reply, not a marketing send, so it's allowed even for opted-out customers
// (matches spec: "Merchants should still be able to view opted-out
// conversations but should not send campaign/promotional messages to them").
// messageType lets sendPaymentLink below tag its send distinctly in the thread.
async function sendManualMessage({ customerId, workspaceId, body, performedBy, messageType = 'manual' }) {
  const customer = await Customer.findOne(scopedFilter(customerId, workspaceId));
  if (!customer) throw new Error('Customer not found');
  const text = (body || '').trim();
  if (!text) throw new Error('Message body is required');

  const result = await waPost({ messaging_product: 'whatsapp', to: customer.phone, type: 'text', text: { body: text } });

  const saved = await WhatsAppMessage.create({
    workspaceId: workspaceId || customer.workspaceId, customer: customer._id, phone: customer.phone,
    direction: 'outbound', messageType, messageBody: text,
    wamid: wamidOf(result), deliveryStatus: 'sent', sentAt: new Date(), performedBy,
  });

  await Customer.findByIdAndUpdate(customer._id, { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 140) });
  return saved;
}

// "Send Payment Link" quick action — creates a real Stripe PaymentIntent for
// a merchant-entered amount and sends it as a manual message, the same
// branded /pay/:piId page used everywhere else (see routes/pay.js).
async function sendPaymentLink({ customerId, workspaceId, amount, performedBy }) {
  const customer = await Customer.findOne(scopedFilter(customerId, workspaceId));
  if (!customer) throw new Error('Customer not found');
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error('Enter a valid amount');

  const currency = await getCurrency();
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(amt * 100), currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: { buyerPhone: customer.phone, source: 'inbox_manual_payment_link' },
  });

  const body = `💳 Here's your payment link for ${money(amt, currency)}:\n${APP_URL}/pay/${pi.id}`;
  return sendManualMessage({ customerId, workspaceId, body, performedBy, messageType: 'payment' });
}

module.exports = {
  logInboundMessage, updateMessageStatus,
  listConversations, getThread, getSnapshot,
  sendManualMessage, sendPaymentLink,
};
