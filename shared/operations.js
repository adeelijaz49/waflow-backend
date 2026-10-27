// Core business operations shared by both integration surfaces:
//   - mcp/tools.js   (MCP protocol, used by Claude)
//   - gpt/routes.js  (plain REST + OpenAPI, used by ChatGPT Custom GPT Actions)
// Keeping the logic here once means a fix/change applies to both surfaces automatically.

const Stripe = require('stripe');
const mongoose = require('mongoose');

const Product   = require('../models/Product');
const Service    = require('../models/Service');
const Customer   = require('../models/Customer');
const Order      = require('../models/Order');
const Promotion  = require('../models/Promotion');
const Settings   = require('../models/Settings');
const TimeSlot   = require('../models/TimeSlot');
const Booking    = require('../models/Booking');
const CampaignMessage = require('../models/CampaignMessage');
const Flow            = require('../models/Flow');
const FlowEnrollment  = require('../models/FlowEnrollment');
const MessageNode     = require('../models/MessageNode');
const ConsentEvent    = require('../models/ConsentEvent');
const {
  sendPromoAnnouncement, sendPointsPromoMessage, sendPromoTemplate,
  sendLoyaltyTemplate, sendLoyaltyReminder, sendRebookMessage, waPost,
  sendCustomFlowTemplate, sendConsentRequestTemplate,
  PROMO_TEMPLATE, LOYALTY_TEMPLATE, WINBACK_TEMPLATE, POST_PURCHASE_TEMPLATE, POINTS_NUDGE_TEMPLATE, NO_SHOW_TEMPLATE, CONSENT_REQUEST_TEMPLATE,
  WINBACK_BODY, POST_PURCHASE_BODY, POINTS_NUDGE_BODY, NO_SHOW_BODY,
  buildPromoAnnouncementPayload, buildPointsPromoPayload,
  createTemplate, getTemplate, getWabaId,
} = require('../utils/whatsapp');
const { carts } = require('../utils/state');
const escapeRegex = require('../utils/escapeRegex');
const { APP_URL } = require('../utils/config');
const { money } = require('../utils/currency');
const settingsCache = require('../utils/settingsCache');
const { getCurrency } = settingsCache;
const consentLib = require('./consent');
const { canSendMarketing, grantMarketingConsent, sendUtilityMessageWithConsentAsk } = consentLib;
const { oneWordLastname } = require('./localization/nameGuard');
// 24-hour-window routing for promotion sends + Meta's real error text (kill switch: PROMO_DELIVERY_FIX=off).
const promoWindow = require('./promoWindow');
const { metaErrorInfo } = require('./promoDelivery');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SHIPPING_COST = 0.5; // flat rate, matches server.js's WhatsApp checkout flow

function wamidOf(sendResult) {
  return sendResult?.messages?.[0]?.id;
}

// Arabic localisation seam (shared/localization/legacySenders.js). Resolves to null - and the code that
// uses it behaves exactly as before - unless the merchant has Arabic on AND an Arabic customer is in this
// send. Never throws.
async function localizedRun(args) {
  try { return await require('./localization/legacySenders').begin(args); } catch (_) { return null; }
}
// Same idea for the session-text notices (booking / order messages). An error flagged localizedSendFailed
// (a send WAS attempted and failed) is rethrown so the caller's own best-effort catch handles it as it does in English.
async function localizedNotice(args) {
  try { return await require('./localization/utilitySend').sendNotice(args); } catch (err) { if (err && err.localizedSendFailed) throw err; return null; }
}

// ─── Multi-tenant scoping (Phase 3) ─────────────────────────────────────────
// workspaceId is optional everywhere on purpose: omitting it preserves this
// codebase's pre-multi-tenant behavior exactly (no filter at all) for any
// caller that doesn't pass one — today that's MCP/GPT Actions and the test
// suite. The real dashboard (routes/*.js) always passes req.user.workspaceId,
// which is what makes isolation real for the surface that actually needs it.
function scopedFilter(id, workspaceId, extra) {
  const filter = { _id: id, ...extra };
  if (workspaceId) filter.workspaceId = workspaceId;
  return filter;
}
function withWorkspace(filter, workspaceId) {
  if (workspaceId) filter.workspaceId = workspaceId;
  return filter;
}
// Aggregation pipelines don't auto-cast strings to ObjectId the way find()
// does — $match needs an explicit cast, or a string workspaceId silently
// matches nothing.
function workspaceMatch(workspaceId) {
  return workspaceId ? { workspaceId: new mongoose.Types.ObjectId(workspaceId) } : {};
}
// The customer (tenant) a Stripe payment belongs to, spread into the PaymentIntent metadata so the Stripe webhook can attribute the
// payment without guessing (see resolveStripeWorkspaceId in server.js). Nothing is added when the workspace is not known.
function stripeWorkspaceMeta(workspaceId) {
  return workspaceId ? { workspaceId: String(workspaceId) } : {};
}

// ─── Demo Mode isolation ───────────────────────────────────────────────────────
// A merchant/reseller in Demo Mode must never trigger a real WhatsApp API call —
// no exceptions, since demo customers can share a single real phone number (see
// seed/seed-demo.js) and Automated Flows run unattended. sendPromotion and
// sendLoyaltyReminders (bulk/automatic paths) fully simulate instead of sending
// whenever the promotion or any targeted customer is isDemo. sendTestMessage is
// deliberately NOT intercepted — it always takes an admin-typed phone number for
// one-off manual preview, a different and intentionally real action.
function fakeWamid() {
  return `demo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Simulates a customer converting on a demo send — creates a real Order/points
// change against the (demo) customer so the campaign report and dashboard look
// alive, without ever touching the WhatsApp API. ~55% conversion rate.
async function simulateDemoConversion({ customer, promotion, items }) {
  if (!items?.length || Math.random() > 0.55) return null;
  const isPoints = promotion?.customerType === 'points';
  const item = items[Math.floor(Math.random() * items.length)];
  const pointsCost = isPoints ? (promotion?.pointsPrice || 0) : 0;

  if (isPoints && (customer.loyaltyPoints || 0) < pointsCost) return null;

  const unitPrice = isPoints ? 0 : +(item.basePrice * (1 - (promotion?.discountPercent || 0) / 100)).toFixed(2);
  const pointsEarned = isPoints ? 0 : Math.max(100, Math.round(unitPrice * 100));
  const pointsDelta = pointsEarned - pointsCost;
  if (pointsDelta) {
    await Customer.findByIdAndUpdate(customer._id, { $inc: { loyaltyPoints: pointsDelta }, $set: { loyaltyPointsUpdatedAt: new Date() } });
  }

  const order = await Order.create({
    customer: customer._id,
    items: [{ productName: item.name, category: item.category || 'General', quantity: 1, unitPrice }],
    subtotal: unitPrice, shippingCost: 0, shippingAddress: customer.address || undefined,
    total: unitPrice, loyaltyPointsUsed: pointsCost, loyaltyDiscount: pointsCost,
    status: 'confirmed', loyaltyPointsEarned: pointsEarned,
    source: 'campaign', promotion: promotion?._id,
    paymentStatus: 'paid', paidAt: new Date(),
  });
  return { order, revenue: unitPrice, pointsIssued: pointsEarned };
}

// ─── Products ────────────────────────────────────────────────────────────────

async function listProducts({ search, category, page = 1, limit = 50, workspaceId } = {}) {
  const filter = withWorkspace({ active: true }, workspaceId);
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
  if (category) filter.category = category;
  const skip = (page - 1) * limit;
  const [products, total] = await Promise.all([
    Product.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);
  return { products, total, page, pages: Math.ceil(total / limit) };
}

async function getProduct({ id, workspaceId }) {
  const product = await Product.findOne(scopedFilter(id, workspaceId));
  if (!product) throw new Error('Product not found');
  return product;
}

async function createProduct(data) {
  return Product.create(data);
}

async function updateProduct({ id, workspaceId, ...data }) {
  const product = await Product.findOneAndUpdate(scopedFilter(id, workspaceId), data, { new: true, runValidators: true });
  if (!product) throw new Error('Product not found');
  return product;
}

async function deactivateProduct({ id, workspaceId }) {
  await Product.findOneAndUpdate(scopedFilter(id, workspaceId), { active: false });
  return { success: true };
}

// ─── Services ────────────────────────────────────────────────────────────────

async function listServices({ workspaceId } = {}) {
  return Service.find(withWorkspace({ active: true }, workspaceId)).sort({ name: 1 });
}

async function getService({ id, workspaceId }) {
  const service = await Service.findOne(scopedFilter(id, workspaceId));
  if (!service) throw new Error('Service not found');
  const slots = await TimeSlot.find({ serviceId: id }).sort({ date: 1, startTime: 1 });
  const bookings = await Booking.find({ serviceId: id }).sort({ createdAt: -1 }).populate('customerId', 'firstname lastname phone');
  return { service, slots, bookings };
}

async function createService(data) {
  return Service.create(data);
}

async function updateService({ id, workspaceId, ...data }) {
  const service = await Service.findOneAndUpdate(scopedFilter(id, workspaceId), data, { new: true });
  if (!service) throw new Error('Service not found');
  return service;
}

async function deactivateService({ id, workspaceId }) {
  await Service.findOneAndUpdate(scopedFilter(id, workspaceId), { active: false });
  return { success: true };
}

async function createTimeSlot({ serviceId, ...data }) {
  return TimeSlot.create({ ...data, serviceId });
}

async function listBookings({ serviceId, customerId, workspaceId } = {}) {
  const filter = withWorkspace({}, workspaceId);
  if (serviceId) filter.serviceId = serviceId;
  if (customerId) filter.customerId = customerId;
  return Booking.find(filter).sort({ createdAt: -1 }).limit(200)
    .populate('serviceId', 'name category')
    .populate('slotId')
    .populate('customerId', 'firstname lastname phone');
}

async function cancelBooking({ bookingId, workspaceId }) {
  const booking = await Booking.findOne(scopedFilter(bookingId, workspaceId)).populate('serviceId').populate('slotId');
  if (!booking) throw new Error('Booking not found');
  if (booking.status === 'cancelled') throw new Error('Already cancelled');
  booking.status = 'cancelled';
  await booking.save();
  await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });
  try {
    const arabic = booking.customerId ? await localizedNotice({ customerId: booking.customerId, workspaceId: booking.workspaceId, phone: booking.phone, withConsentAsk: false, refId: booking._id, localized: { key: 'senders.bookingCancelled', buttons: [{ id: `rebook_${booking.serviceId?._id}_${booking._id}`, titleKey: 'senders.bookingCancelledButton' }], values: () => require('./localization/senderValues').bookingNoticeValuesAsync(booking) } }) : null;
    const result = arabic ? arabic.result : await sendRebookMessage(
      booking.phone, booking.customerName || 'Valued Customer',
      booking.serviceId?.name || 'your service', booking.slotId,
      booking.serviceId?._id?.toString(), booking._id.toString(),
    );
    if (booking.customerId) {
      await CampaignMessage.create({
        kind: 'booking_notification', booking: booking._id, customer: booking.customerId, phone: booking.phone,
        wamid: wamidOf(result), messageType: 'interactive', status: 'sent', sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (_) { /* best-effort notification — booking is already cancelled either way */ }
  return { success: true };
}

async function rescheduleBooking({ bookingId, newSlotId, workspaceId }) {
  const booking = await Booking.findOne(scopedFilter(bookingId, workspaceId)).populate('serviceId').populate('slotId');
  if (!booking) throw new Error('Booking not found');
  const newSlot = await TimeSlot.findOne(scopedFilter(newSlotId, workspaceId)); // a slot of ANOTHER customer is "not found"
  if (!newSlot) throw new Error('New slot not found');
  if (newSlot.bookedCount >= newSlot.capacity) throw new Error('Slot is full');
  await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });
  await TimeSlot.findByIdAndUpdate(newSlotId, { $inc: { bookedCount: 1 } });
  booking.slotId = newSlotId;
  booking.status = 'confirmed';
  await booking.save();
  try {
    const arabic = booking.customerId ? await localizedNotice({ customerId: booking.customerId, workspaceId: booking.workspaceId, phone: booking.phone, withConsentAsk: false, refId: booking._id, localized: { key: 'senders.bookingRescheduled', values: () => require('./localization/senderValues').bookingNoticeValuesAsync(booking, newSlot) } }) : null;
    const result = arabic ? arabic.result : await waPost({
      messaging_product: 'whatsapp', to: booking.phone, type: 'text',
      text: { body: `📅 Your booking for *${booking.serviceId?.name}* has been rescheduled to *${newSlot.date} at ${newSlot.startTime}*. See you then! 🎉` },
    });
    if (booking.customerId) {
      await CampaignMessage.create({
        kind: 'booking_notification', booking: booking._id, customer: booking.customerId, phone: booking.phone,
        wamid: wamidOf(result), messageType: 'text', status: 'sent', sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (_) { /* best-effort notification — reschedule already applied either way */ }
  return { success: true };
}

async function completeBooking({ bookingId, workspaceId }) {
  await Booking.findOneAndUpdate(scopedFilter(bookingId, workspaceId), { status: 'completed' });
  return { success: true };
}

// A "Reserve — Pay in Person" booking sits as 'requested' until the merchant
// reviews it — these three transitions are that review action.
async function confirmBooking({ bookingId, workspaceId }) {
  const booking = await Booking.findOne(scopedFilter(bookingId, workspaceId)).populate('serviceId').populate('slotId');
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'requested') throw new Error('Only requested bookings can be confirmed');
  booking.status = 'confirmed';
  await booking.save();
  try {
    const body = `✅ *Booking Confirmed!*\n\n📋 ${booking.serviceId?.name}\n📅 ${booking.slotId?.date} at ${booking.slotId?.startTime}\n\nSee you then! 🎉`;
    // This confirmation is a merchant reviewing a "pay in person" request,
    // possibly well after the customer's own message — sendUtilityMessage
    // WithConsentAsk falls back to a plain-text send if the interactive
    // consent-ask fails outside the 24h session window.
    const customer = booking.customerId ? await Customer.findById(booking.customerId) : null;
    const result = customer
      ? await sendUtilityMessageWithConsentAsk({ customer, workspaceId, body, localized: { key: 'senders.bookingConfirmed', values: () => require('./localization/senderValues').bookingNoticeValuesAsync(booking), templateFallback: 'booking_confirmation' } })
      : await waPost({ messaging_product: 'whatsapp', to: booking.phone, type: 'text', text: { body } });
    if (booking.customerId) {
      await CampaignMessage.create({
        kind: 'booking_notification', booking: booking._id, customer: booking.customerId, phone: booking.phone,
        wamid: wamidOf(result), messageType: 'text', status: 'sent', sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (_) { /* best-effort notification — booking is already confirmed either way */ }
  return booking;
}

async function declineBooking({ bookingId, workspaceId }) {
  const booking = await Booking.findOne(scopedFilter(bookingId, workspaceId)).populate('serviceId').populate('slotId');
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'requested') throw new Error('Only requested bookings can be declined');
  booking.status = 'cancelled';
  await booking.save();
  await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });
  try {
    const arabic = booking.customerId ? await localizedNotice({ customerId: booking.customerId, workspaceId: booking.workspaceId, phone: booking.phone, withConsentAsk: false, refId: booking._id, localized: { key: 'senders.bookingDeclined', values: () => require('./localization/senderValues').bookingNoticeValuesAsync(booking) } }) : null;
    const result = arabic ? arabic.result : await waPost({
      messaging_product: 'whatsapp', to: booking.phone, type: 'text',
      text: { body: `We're sorry, we're unable to accommodate your request for *${booking.serviceId?.name}* on *${booking.slotId?.date} at ${booking.slotId?.startTime}*. Please pick another time — we'd love to see you!` },
    });
    if (booking.customerId) {
      await CampaignMessage.create({
        kind: 'booking_notification', booking: booking._id, customer: booking.customerId, phone: booking.phone,
        wamid: wamidOf(result), messageType: 'text', status: 'sent', sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (_) { /* best-effort notification — decline already applied either way */ }
  return booking;
}

// Manual, post-hoc — the customer never showed for a confirmed slot. No slot-capacity
// change (the slot already happened) and no customer notification (nothing to tell them).
async function markNoShow({ bookingId, workspaceId }) {
  const booking = await Booking.findOne(scopedFilter(bookingId, workspaceId));
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'confirmed') throw new Error('Only confirmed bookings can be marked no-show');
  booking.status = 'no-show';
  await booking.save();
  return booking;
}

// ─── Customers ───────────────────────────────────────────────────────────────

// ─── Consent status helpers (customers screen, audience filters, consent log) ─
// The three states the screens speak about; the filter shapes mirror shared/consent.js#deriveConsentStatus so a
// customer is in exactly one of them. Own keys only: a query string such as ?consent=constructor must not resolve.
const CONSENT_STATUS_FILTERS = {
  opted_in:      { marketingConsent: true, optedOut: { $ne: true } },
  opted_out:     { optedOut: true },
  not_responded: { marketingConsent: { $ne: true }, optedOut: { $ne: true }, deletedAt: null },
};

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

// '' / undefined = no filter. Anything else must be one of the three, else a 400.
function normalizeConsentFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value);
  if (!Object.prototype.hasOwnProperty.call(CONSENT_STATUS_FILTERS, v)) {
    throw badRequest('consent must be opted_in, opted_out or not_responded', 'INVALID_CONSENT_FILTER');
  }
  return v;
}

// A fresh copy each time: mongoose may cast a query object in place, so the shared constants are never handed out.
function consentQueryFor(status) {
  return JSON.parse(JSON.stringify(CONSENT_STATUS_FILTERS[status]));
}

function consentStatusOf(customer) {
  if (typeof consentLib.deriveConsentStatus === 'function') return consentLib.deriveConsentStatus(customer);
  if (!customer) return 'not_responded';
  if (customer.optedOut === true) return 'opted_out';
  if (customer.marketingConsent === true) return 'opted_in';
  return 'not_responded';
}

// Latest ConsentEvent of each TYPE for each customer in `customerIds` (one aggregate for a whole page of the customers list):
// Map(customerId -> { [type]: { eid, at, type, method, source, promotionName } }). Sorted by _id only (creation order; always
// indexed - Cosmos DB for MongoDB rejects a {createdAt, _id} sort that no compound index serves).
async function latestConsentEventsByCustomer(customerIds, workspaceId) {
  const out = new Map();
  if (!customerIds.length) return out;
  const rows = await ConsentEvent.aggregate([
    { $match: { ...workspaceMatch(workspaceId), customerId: { $in: customerIds } } },
    { $sort: { _id: -1 } },
    { $group: {
      _id: { c: '$customerId', t: '$type' },
      eid: { $first: '$_id' },
      at: { $first: { $ifNull: ['$tappedAt', '$createdAt'] } },
      method: { $first: '$method' }, source: { $first: '$source' },
      promotionName: { $first: '$promotionName' },
    } },
  ]);
  for (const r of rows) {
    const key = String(r._id.c);
    if (!out.has(key)) out.set(key, {});
    out.get(key)[r._id.t] = { eid: r.eid, at: r.at, type: r._id.t, method: r.method, source: r.source, promotionName: r.promotionName };
  }
  return out;
}

// The event that explains the customer's CURRENT status: the last withdrawal for an opted-out customer, the last opt-in for an
// opted-in one (a staff attestation recorded after a STOP does not make an opted-out customer look consented), else the latest
// event of any kind. null when the customer has no event.
const DECIDING_EVENT_TYPES = { opted_out: ['consent_withdrawn'], opted_in: ['consent_given', 'consent_reinstated'] };
function decisiveConsentEvent(byType, status) {
  const rows = byType ? Object.values(byType) : [];
  if (!rows.length) return null;
  const wanted = DECIDING_EVENT_TYPES[status];
  const pool = wanted ? rows.filter(r => wanted.includes(r.type)) : [];
  return (pool.length ? pool : rows).reduce((best, r) => (!best || String(r.eid) > String(best.eid) ? r : best), null);
}

async function listCustomers({ search, isDemo, ids: filterIds, page = 1, limit = 50, workspaceId, consent } = {}) {
  const consentFilter = normalizeConsentFilter(consent);
  const filter = withWorkspace({}, workspaceId);
  if (consentFilter) Object.assign(filter, consentQueryFor(consentFilter));
  // Smart Insights' "View Customers" CTAs land here with the exact matching
  // customer ids from whatever aggregation produced the insight (e.g. the 20
  // inactive customers) — a fixed id list, not a new filter language to build
  // and maintain server-side.
  if (filterIds?.length) filter._id = { $in: filterIds };
  if (search) {
    const term = escapeRegex(search); // what a person typed is text to find, never a pattern
    filter.$or = [
      { firstname: { $regex: term, $options: 'i' } },
      { lastname: { $regex: term, $options: 'i' } },
      { phone: { $regex: term, $options: 'i' } },
      // A "First Last" search matches neither field alone above — match against
      // the concatenated full name too, so a full-name search actually works.
      { $expr: { $regexMatch: { input: { $concat: ['$firstname', ' ', '$lastname'] }, regex: term, options: 'i' } } },
    ];
  }
  if (isDemo !== undefined) filter.isDemo = isDemo === true || isDemo === 'true';
  const skip = (page - 1) * limit;
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ firstname: 1 }).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);

  const ids = customers.map(c => c._id);
  const stats = await Order.aggregate([
    { $match: { customer: { $in: ids } } },
    { $group: {
      _id: '$customer',
      orderCount: { $sum: 1 },
      totalSpent: { $sum: '$total' },
      lastOrder:  { $max: '$createdAt' },
    }},
  ]);
  const statsMap = Object.fromEntries(stats.map(s => [s._id.toString(), s]));

  // Consent column: the ConsentEvent that explains each customer's current status (a failed lookup only leaves the source empty).
  let latestConsent = new Map();
  try { latestConsent = await latestConsentEventsByCustomer(ids, workspaceId); } catch (err) {
    console.error('[listCustomers] consent lookup failed:', err.message);
  }

  const enriched = customers.map(c => {
    const status = consentStatusOf(c);
    const ev = decisiveConsentEvent(latestConsent.get(c._id.toString()), status);
    return {
      ...c.toObject(),
      orderCount: statsMap[c._id.toString()]?.orderCount ?? 0,
      totalSpent: statsMap[c._id.toString()]?.totalSpent ?? 0,
      lastOrder:  statsMap[c._id.toString()]?.lastOrder  ?? null,
      consentStatus: status,
      consentAt: ev ? ev.at : (c.marketingConsentAt || null),
      consentSource: ev ? (ev.source || ev.method || null) : (c.marketingConsentMethod || null),
      consentMethod: ev ? (ev.method || null) : (c.marketingConsentMethod || null),
      consentPromotionName: ev ? (ev.promotionName || null) : null,
    };
  });

  return { customers: enriched, total, page, pages: Math.ceil(total / limit) };
}

async function getCustomer({ id, workspaceId }) {
  const customer = await Customer.findOne(scopedFilter(id, workspaceId));
  if (!customer) throw new Error('Customer not found');
  const orders = await Order.find({ customer: id }).sort({ createdAt: -1 });
  const totalSpent = orders.reduce((s, o) => s + (o.total || 0), 0);
  return { ...customer.toObject(), orders, totalSpent };
}

// The lighter WhatsApp history: reuses CampaignMessage (already written for every
// promotion/loyalty/booking-notification send) rather than a full chat transcript.
async function getCustomerWhatsAppHistory({ customerId, workspaceId }) {
  return CampaignMessage.find(withWorkspace({ customer: customerId }, workspaceId))
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('promotion', 'name')
    .populate('booking');
}

// marketingConsent/performedBy are pulled out rather than passed straight to
// Customer.create — every consent grant must go through grantMarketingConsent
// so it's logged to ConsentEvent, never silently set as a bare field. MCP/GPT
// Actions tool schemas don't declare marketingConsent, so it can never arrive
// here through those surfaces (same precedent as allowRealDemoSend).
async function createCustomer({ marketingConsent, performedBy, ...data }) {
  delete data.isDemo; // demo records (which skip the consent gate) come from the seed script only, never from a request
  if (!String(data.lastname || '').trim()) data.lastname = (await oneWordLastname(data.workspaceId)) || data.lastname; // IM-D B4b: flagged workspaces only
  const customer = await Customer.create(data); // always created with schema default marketingConsent:false
  if (marketingConsent === true) {
    await grantMarketingConsent({ customer, method: 'manual_staff_entry', source: 'Add Customer form', performedBy, workspaceId: data.workspaceId });
  }
  return customer;
}

async function updateCustomer({ id, workspaceId, ...data }) {
  // These five fields are mutable ONLY via shared/consent.js's helpers, so
  // every change is guaranteed to also write a ConsentEvent — stripped here
  // regardless of caller, since this generic edit path has no way to log one.
  delete data.marketingConsent; delete data.marketingConsentAt; delete data.marketingConsentMethod;
  delete data.optedOut; delete data.optedOutAt;
  delete data.isDemo; // see createCustomer
  for (const key of Object.keys(data)) if (key.startsWith('$')) delete data[key]; // an update operator would bypass the rules above
  const customer = await Customer.findOneAndUpdate(scopedFilter(id, workspaceId), data, { new: true, runValidators: true });
  if (!customer) throw new Error('Customer not found');
  return customer;
}

// The only dashboard path to grant an EXISTING customer's marketing consent
// directly — the checkbox at creation only covers new customers, and the
// WhatsApp button only fires on their next order/booking (or the bulk
// campaign, which needs an approved template). For a merchant who already
// has this customer's real agreement from elsewhere (in person, a prior
// conversation, a paper form), this is the honest way to record it — same
// method as the manual Add Customer checkbox, just applied after the fact.
async function markCustomerConsented({ id, workspaceId, performedBy }) {
  const customer = await Customer.findOne(scopedFilter(id, workspaceId));
  if (!customer) throw new Error('Customer not found');
  await grantMarketingConsent({
    customer, method: 'manual_staff_entry', source: 'Marked consented from customer detail panel',
    performedBy, workspaceId,
  });
  return customer;
}

// Customers who've never been asked at all — not yet consented, not opted
// out, not demo data, and marketingConsentAskedAt still unset (so this never
// re-asks someone who already tapped "No thanks" via either method, or who's
// waiting on the order-confirmation ask to land). Shared by getConsentStats'
// count and sendConsentRequests' actual send loop so they can never drift.
function consentRequestEligibleFilter(workspaceId, customerIds) {
  return withWorkspace({
    marketingConsent: { $ne: true },
    marketingConsentAskedAt: { $exists: false },
    optedOut: { $ne: true },
    isDemo: { $ne: true },
    ...(customerIds?.length ? { _id: { $in: customerIds } } : {}),
  }, workspaceId);
}

// Backs the Settings "Privacy & Compliance" section — a workspace-scoped
// summary of where customers stand on marketing consent, plus a recent
// ConsentEvent feed so a merchant can see consent/opt-out activity happening.
async function getConsentStats({ workspaceId }) {
  const [consented, optedOut, total, eligibleForConsentRequest, recentEvents] = await Promise.all([
    Customer.countDocuments(withWorkspace({ marketingConsent: true, optedOut: { $ne: true } }, workspaceId)),
    Customer.countDocuments(withWorkspace({ optedOut: true }, workspaceId)),
    Customer.countDocuments(withWorkspace({}, workspaceId)),
    Customer.countDocuments(consentRequestEligibleFilter(workspaceId)),
    ConsentEvent.find(withWorkspace({}, workspaceId)).sort({ createdAt: -1 }).limit(20)
      .populate('customerId', 'firstname lastname phone').lean(),
  ]);
  const notYetConsented = total - consented - optedOut;
  return {
    consented, optedOut, notYetConsented, total, eligibleForConsentRequest,
    recentEvents: recentEvents.map(e => ({
      type: e.type, method: e.method, source: e.source, createdAt: e.createdAt,
      customerName: e.customerId ? `${e.customerId.firstname} ${e.customerId.lastname}`.trim() : undefined,
      phone: e.phone,
    })),
  };
}

// ─── Consent log (who agreed/withdrew, to what, when) ─────────────────────────
// `status` filters the log by what happened: opted_in = a customer opted in (or was reinstated), opted_out = withdrawals,
// not_responded = declines. A raw event type (consent_given ...) is accepted too. Always scoped to ONE workspace.
const CONSENT_LOG_TYPES = {
  opted_in:      ['consent_given', 'consent_reinstated'],
  opted_out:     ['consent_withdrawn'],
  not_responded: ['consent_declined'],
};
const CONSENT_EVENT_TYPES = ['consent_given', 'consent_withdrawn', 'consent_reinstated', 'consent_declined'];
const CONSENT_LOG_CSV_COLUMNS = [
  'eventTimeUtc', 'customerName', 'phone', 'type', 'method', 'source', 'promotionId', 'promotionName',
  'messageText', 'buttonLabel', 'buttonAction', 'sourceWamid', 'inboundWamid', 'signature',
];
const CONSENT_LOG_CSV_MAX_ROWS = 50000;

function consentLogFilter({ workspaceId, status, promotionId }) {
  if (!workspaceId) throw badRequest('workspaceId required', 'WORKSPACE_REQUIRED');
  const filter = { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) };
  if (status !== undefined && status !== null && status !== '') {
    const s = String(status);
    if (Object.prototype.hasOwnProperty.call(CONSENT_LOG_TYPES, s)) filter.type = { $in: CONSENT_LOG_TYPES[s] };
    else if (CONSENT_EVENT_TYPES.includes(s)) filter.type = s;
    else throw badRequest('status must be opted_in, opted_out or not_responded', 'INVALID_CONSENT_FILTER');
  }
  if (promotionId !== undefined && promotionId !== null && promotionId !== '') {
    if (!/^[0-9a-fA-F]{24}$/.test(String(promotionId))) throw badRequest('promotionId is not valid', 'INVALID_PROMOTION_ID');
    filter.promotionId = new mongoose.Types.ObjectId(String(promotionId));
  }
  return filter;
}

const isoOrNull = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null; };

// One consent-log row. eventTimeUtc is when the customer tapped (WhatsApp's own timestamp) when we have it, else when we
// recorded the event.
function consentLogRow(e, customer) {
  const name = customer ? `${customer.firstname || ''} ${customer.lastname || ''}`.trim() : '';
  return {
    id: String(e._id),
    eventTimeUtc: isoOrNull(e.tappedAt) || isoOrNull(e.createdAt),
    recordedAtUtc: isoOrNull(e.createdAt),
    customerId: e.customerId && e.customerId._id ? String(e.customerId._id) : (e.customerId ? String(e.customerId) : null),
    customerName: name,
    phone: e.phone || '',
    type: e.type,
    method: e.method || '',
    source: e.source || '',
    promotionId: e.promotionId ? String(e.promotionId) : '',
    promotionName: e.promotionName || '',
    messageText: e.messageText || '',
    buttonLabel: e.buttonLabel || '',
    buttonAction: e.buttonAction || '',
    sourceWamid: e.sourceWamid || '',
    inboundWamid: e.inboundWamid || '',
    signature: e.signature || '',
  };
}

// The customer behind each event, looked up once per batch (names only; an erased customer reads as its anonymised self).
async function customersForEvents(events, workspaceId) {
  const ids = [...new Set(events.map(e => (e.customerId && e.customerId._id ? e.customerId._id : e.customerId)).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await Customer.find(withWorkspace({ _id: { $in: ids } }, workspaceId), 'firstname lastname').lean();
  return new Map(rows.map(c => [String(c._id), c]));
}

async function getConsentLog({ workspaceId, status, promotionId, page = 1, limit = 50 } = {}) {
  const filter = consentLogFilter({ workspaceId, status, promotionId });
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const [events, total] = await Promise.all([
    // newest first by _id (creation order; always indexed: Cosmos DB for MongoDB rejects a {createdAt, _id} sort no compound index serves)
    ConsentEvent.find(filter).sort({ _id: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
    ConsentEvent.countDocuments(filter),
  ]);
  const byId = await customersForEvents(events, workspaceId);
  return {
    events: events.map(e => consentLogRow(e, byId.get(String(e.customerId)))),
    total, page: pg, limit: lim, pages: Math.ceil(total / lim),
  };
}

// CSV text (UTF-8 BOM, CRLF via shared/localization/csv.js, spreadsheet formulas neutralised by csvSafe below). `truncated` = more rows exist.
async function getConsentLogCsv({ workspaceId, status, promotionId } = {}) {
  const { stringifyCsv } = require('./localization/csv');
  const filter = consentLogFilter({ workspaceId, status, promotionId });
  const events = await ConsentEvent.find(filter).sort({ _id: -1 }).limit(CONSENT_LOG_CSV_MAX_ROWS + 1).lean();
  const truncated = events.length > CONSENT_LOG_CSV_MAX_ROWS;
  if (truncated) events.length = CONSENT_LOG_CSV_MAX_ROWS;
  const byId = await customersForEvents(events, workspaceId);
  const rows = events.map(e => { const r = consentLogRow(e, byId.get(String(e.customerId))); return CONSENT_LOG_CSV_COLUMNS.map(c => csvSafe(r[c])); });
  return { csv: stringifyCsv([CONSENT_LOG_CSV_COLUMNS, ...rows], { neutralizeFormulas: false }), count: events.length, truncated };
}

// Spreadsheet formula injection: a cell starting with = + - @ (or a tab / carriage return) is read as a formula, and a
// customer's name comes from WhatsApp, so it is attacker-controlled. Such a cell gets a leading quote - except one that is
// only a number or a phone number (digits, spaces, + - . ( ) and nothing else: no letters means no function call). Stricter
// than shared/localization/csv.js, which also lets "+1+cmd|..." through because it starts with a digit.
const CSV_NUMBER_LIKE = /^[+-]?\d[\d\s().-]*$/;
function csvSafe(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) && !CSV_NUMBER_LIKE.test(s) ? `'${s}` : s;
}

async function getCustomerConsentEvents({ customerId, workspaceId } = {}) {
  if (!workspaceId) throw badRequest('workspaceId required', 'WORKSPACE_REQUIRED');
  const customer = await Customer.findOne(scopedFilter(customerId, workspaceId), 'firstname lastname').lean();
  if (!customer) throw new Error('Customer not found');
  const events = await ConsentEvent.find({ workspaceId: new mongoose.Types.ObjectId(String(workspaceId)), customerId: customer._id })
    .sort({ _id: -1 }).limit(200).lean();
  return events.map(e => consentLogRow(e, customer));
}

// Bulk "ask for consent" campaign for customers already in the system before
// this feature shipped (or who simply haven't placed a fresh order/booking
// since) — the only other consent-capture paths (the order-confirmation
// button, and the manual/CSV checkbox) don't reach them. Sends a real
// approved WhatsApp template (see utils/whatsapp.js#sendConsentRequestTemplate)
// since these customers are almost always outside the 24h session window,
// unlike the free-form interactive ask. Asked at most once — see
// consentRequestEligibleFilter — matching the order-confirmation ask's own
// "once per customer" rule.
async function sendConsentRequests({ workspaceId, customerIds } = {}) {
  const customers = await Customer.find(consentRequestEligibleFilter(workspaceId, customerIds));
  let sentCount = 0;
  const errors = [];
  const loc = await localizedRun({ sender: 'consent_request', workspaceId, customers });
  for (const c of customers) {
    try {
      // Arabic opt-in ask: loc does its own bookkeeping (asked-at stamp + consent_request CampaignMessage).
      const arabic = loc ? await loc.trySend(c) : null;
      if (arabic) {
        if (arabic.skip) continue;
        if (arabic.sent) sentCount++; else errors.push({ customerId: c._id, phone: c.phone, error: arabic.failReason });
        continue;
      }
      const result = await sendConsentRequestTemplate(c.phone, c.firstname, c._id);
      await Customer.findByIdAndUpdate(c._id, { marketingConsentAskedAt: new Date() });
      await CampaignMessage.create({
        workspaceId, kind: 'consent_request', customer: c._id, phone: c.phone,
        wamid: wamidOf(result), messageType: 'template', templateName: CONSENT_REQUEST_TEMPLATE,
        status: 'sent', sentAt: new Date(),
      }).catch(() => {});
      sentCount++;
      if (loc) await loc.record(c, { sent: true, result });
    } catch (err) {
      errors.push({ customerId: c._id, phone: c.phone, error: err.message });
      if (loc) await loc.record(c, { sent: false, failReason: err.message });
    }
  }
  return { totalEligible: customers.length, sentCount, errors, ...(loc ? loc.summary() : {}) };
}

// ─── Orders ──────────────────────────────────────────────────────────────────

async function listOrders({ status, source, paymentStatus, page = 1, limit = 50, workspaceId } = {}) {
  const filter = withWorkspace({}, workspaceId);
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter).populate('customer', 'firstname lastname phone').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);
  return { orders, total, page, pages: Math.ceil(total / limit) };
}

async function getOrder({ id, workspaceId }) {
  const order = await Order.findOne(scopedFilter(id, workspaceId)).populate('customer', 'firstname lastname phone loyaltyPoints');
  if (!order) throw new Error('Order not found');
  return order;
}

async function updateOrderStatus({ id, status, workspaceId }) {
  const order = await Order.findOneAndUpdate(scopedFilter(id, workspaceId), { status }, { new: true });
  if (!order) throw new Error('Order not found');
  return order;
}

async function refundOrder({ id, workspaceId }) {
  const order = await Order.findOne(scopedFilter(id, workspaceId));
  if (!order) throw new Error('Order not found');
  if (order.paymentStatus !== 'paid') throw new Error('Only paid orders can be refunded');
  if (!order.stripePaymentIntentId) throw new Error('This order has no Stripe payment to refund');
  await stripe.refunds.create({ payment_intent: order.stripePaymentIntentId });
  order.paymentStatus = 'refunded';
  await order.save();
  return order;
}

// Counts customers whose orders show a >60-day gap immediately before an order
// with source:'campaign' — i.e. they'd gone quiet and a campaign brought them back.
// Done in JS rather than a single aggregation pipeline: order volumes here are
// small (a real small business, not an enterprise catalog), and the "gap between
// consecutive orders per customer" shape is much easier to get right as a loop
// than as a $map/$range aggregation expression.
async function countInactiveRecovered({ workspaceId } = {}) {
  const orders = await Order.find(withWorkspace({ status: { $ne: 'cancelled' } }, workspaceId), 'customer createdAt source')
    .sort({ customer: 1, createdAt: 1 }).lean();
  const byCustomer = new Map();
  for (const o of orders) {
    const key = o.customer.toString();
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(o);
  }
  const INACTIVE_MS = 60 * 24 * 60 * 60 * 1000;
  let recovered = 0;
  for (const list of byCustomer.values()) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].source === 'campaign' && (new Date(list[i].createdAt) - new Date(list[i - 1].createdAt)) > INACTIVE_MS) {
        recovered++;
        break; // count each customer at most once
      }
    }
  }
  return recovered;
}

async function getOrderStats({ workspaceId } = {}) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const wm = workspaceMatch(workspaceId);
  const [
    totalOrders, totalCustomers, recentRevenue, statusBreakdown, recentOrders,
    repeatAgg, campaignRevenueAgg, campaignOrdersAgg, messagesSent, pointsAgg, inactiveRecovered,
  ] = await Promise.all([
    Order.countDocuments(withWorkspace({}, workspaceId)),
    Customer.countDocuments(withWorkspace({}, workspaceId)),
    Order.aggregate([
      { $match: { ...wm, createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, revenue: { $sum: '$total' } } },
    ]),
    Order.aggregate([{ $match: wm }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.find(withWorkspace({}, workspaceId)).populate('customer', 'firstname lastname').sort({ createdAt: -1 }).limit(10),
    Order.aggregate([
      { $match: { ...wm, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$customer', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'repeatCustomers' },
    ]),
    Order.aggregate([
      { $match: { ...wm, source: 'campaign', status: { $ne: 'cancelled' } } },
      { $group: { _id: null, revenue: { $sum: '$total' } } },
    ]),
    Order.aggregate([
      { $match: { ...wm, source: 'campaign', status: { $ne: 'cancelled' } } },
      { $count: 'count' },
    ]),
    CampaignMessage.countDocuments(withWorkspace({ kind: 'promotion', status: { $in: ['sent', 'delivered', 'read'] } }, workspaceId)),
    Order.aggregate([
      { $match: { ...wm, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, points: { $sum: '$loyaltyPointsEarned' } } },
    ]),
    countInactiveRecovered({ workspaceId }),
  ]);

  const campaignOrders = campaignOrdersAgg[0]?.count ?? 0;
  const conversionRate = messagesSent > 0 ? +((campaignOrders / messagesSent) * 100).toFixed(1) : 0;

  return {
    totalOrders, totalCustomers, recentRevenue: recentRevenue[0]?.revenue ?? 0, statusBreakdown, recentOrders,
    repeatCustomers: repeatAgg[0]?.repeatCustomers ?? 0,
    campaignRevenue: campaignRevenueAgg[0]?.revenue ?? 0,
    inactiveCustomersRecovered: inactiveRecovered,
    messagesSent,
    loyaltyPointsIssued: pointsAgg[0]?.points ?? 0,
    conversionRate,
  };
}

// Per-campaign funnel: sent → delivered → read → clicked → ordered → revenue/points.
async function getCampaignReport({ promotionId, workspaceId }) {
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId));
  if (!promotion) throw new Error('Promotion not found');

  const agg = await CampaignMessage.aggregate([
    { $match: { promotion: promotion._id, kind: 'promotion' } },
    { $group: {
      _id: null,
      sent:         { $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] } },
      delivered:    { $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] } },
      read:         { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
      failed:       { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      // $gt (not $ne) against null — in aggregation expressions a genuinely
      // missing field is its own BSON type, distinct from and NOT equal to
      // null, so $ne incorrectly counts every message that's never been
      // clicked/ordered. $gt follows BSON comparison order, where missing
      // and null both sort lowest, so it correctly excludes both.
      clicked:      { $sum: { $cond: [{ $gt: ['$clickedAt', null] }, 1, 0] } },
      ordered:      { $sum: { $cond: [{ $gt: ['$order', null] }, 1, 0] } },
      revenue:      { $sum: '$revenue' },
      pointsIssued: { $sum: '$pointsIssued' },
    } },
  ]);

  const c = agg[0] || { sent: 0, delivered: 0, read: 0, failed: 0, clicked: 0, ordered: 0, revenue: 0, pointsIssued: 0 };
  const conversionRate = c.sent > 0 ? +((c.ordered / c.sent) * 100).toFixed(1) : 0;

  const report = {
    promotionId: promotion._id,
    name: promotion.name,
    messagesSent: c.sent,
    messagesDelivered: c.delivered,
    messagesRead: c.read,
    messagesFailed: c.failed,
    clicked: c.clicked,
    ordersCreated: c.ordered,
    revenue: +c.revenue.toFixed(2),
    pointsIssued: c.pointsIssued,
    conversionRate,
  };
  // Opt-in / opt-out results: only for a consent request or a promotion with consent-action buttons (every other
  // promotion keeps exactly the shape above).
  const consent = await consentReportFor(promotion, { sent: c.sent, delivered: c.delivered });
  if (consent) report.consent = consent;
  return report;
}

// Percentage with one decimal over the delivered messages (the sent ones when delivery is not known yet).
function consentRate(count, delivered, sent) {
  const base = delivered > 0 ? delivered : sent;
  return base > 0 ? +((count / base) * 100).toFixed(1) : 0;
}

// People who opted in / out through this promotion (distinct customers, from the consent log: the evidence, not a
// counter), people who tapped "interested", and every other tap. Taps come from the CampaignMessage rows.
function buildConsentReport({ optIns, optOuts, interested, otherTaps, delivered, sent }) {
  return {
    optIns, optOuts, interested, otherTaps,
    optInRate: consentRate(optIns, delivered, sent),
    optOutRate: consentRate(optOuts, delivered, sent),
  };
}

async function consentReportFor(promotion, { sent, delivered }) {
  let hasConsentButtons = false;
  if (promotion.purpose !== 'consent_request' && promotion.entryNodeId) {
    const node = await loadEntryNode(promotion);
    hasConsentButtons = !!(node && node.buttons.some(b => CONSENT_ACTIONS.includes(b.nextAction && b.nextAction.type)));
  }
  if (promotion.purpose !== 'consent_request' && !hasConsentButtons) return null;

  const eventFilter = { promotionId: promotion._id, ...(promotion.workspaceId ? { workspaceId: promotion.workspaceId } : {}) };
  const [optedIn, optedOut, tapAgg] = await Promise.all([
    ConsentEvent.distinct('customerId', { ...eventFilter, type: 'consent_given' }),
    ConsentEvent.distinct('customerId', { ...eventFilter, type: 'consent_withdrawn' }),
    CampaignMessage.aggregate([
      { $match: { promotion: promotion._id, kind: 'promotion', $or: [{ respondedAt: { $ne: null } }, { clickedButtonAction: { $ne: null } }] } },
      { $group: { _id: '$clickedButtonAction', count: { $sum: 1 } } },
    ]),
  ]);
  let interested = 0;
  let otherTaps = 0;
  for (const row of tapAgg) {
    if (row._id === 'interested') interested += row.count;
    else if (row._id !== 'opt_in' && row._id !== 'opt_out') otherTaps += row.count;
  }
  return buildConsentReport({ optIns: optedIn.length, optOuts: optedOut.length, interested, otherTaps, delivered, sent });
}

// ─── AI Mode analytics (read-only — closes gaps get_order_stats/get_campaign_report
// /get_recommended_customers don't cover; see ai/tools.js) ────────────────────

// "How many customers returned this month?" — an existing customer (with order
// history before the target month) who ordered again within it. Distinct from
// getOrderStats' repeatCustomers, which is an all-time count, not month-scoped.
async function getCustomerReturnRate({ month, year, workspaceId } = {}) {
  const now = new Date();
  const targetMonth = month ?? (now.getMonth() + 1); // 1-indexed
  const targetYear = year ?? now.getFullYear();
  const rangeStart = new Date(targetYear, targetMonth - 1, 1);
  const rangeEnd = new Date(targetYear, targetMonth, 1);

  const [customersThisMonth, priorCustomerIds] = await Promise.all([
    Order.distinct('customer', withWorkspace({ status: { $ne: 'cancelled' }, createdAt: { $gte: rangeStart, $lt: rangeEnd } }, workspaceId)),
    Order.distinct('customer', withWorkspace({ status: { $ne: 'cancelled' }, createdAt: { $lt: rangeStart } }, workspaceId)),
  ]);
  const priorSet = new Set(priorCustomerIds.map(id => id.toString()));
  const returningCustomers = customersThisMonth.filter(id => priorSet.has(id.toString())).length;

  return { month: targetMonth, year: targetYear, totalCustomersThisMonth: customersThisMonth.length, returningCustomers };
}

// "Which customer has the most loyalty points?" — no existing tool does this
// ranked lookup (get_customer/update_customer only touch one customer at a time).
async function getTopLoyaltyCustomers({ limit = 5, workspaceId } = {}) {
  const customers = await Customer.find(withWorkspace({ isDemo: { $ne: true } }, workspaceId)).sort({ loyaltyPoints: -1 }).limit(limit);
  return customers.map(c => ({
    id: c._id, name: `${c.firstname} ${c.lastname}`.trim(), phone: c.phone, loyaltyPoints: c.loyaltyPoints,
  }));
}

// "Which promotion performed best?" — getCampaignReport reports one promotion
// at a time; this reuses its exact CampaignMessage aggregation shape but
// grouped across every promotion at once, then ranked by the requested metric.
async function getBestPerformingPromotion({ metric = 'revenue', limit = 5, workspaceId } = {}) {
  const agg = await CampaignMessage.aggregate([
    { $match: { ...workspaceMatch(workspaceId), kind: 'promotion', promotion: { $ne: null } } },
    { $group: {
      _id: '$promotion',
      sent:    { $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] } },
      ordered: { $sum: { $cond: [{ $gt: ['$order', null] }, 1, 0] } },
      revenue: { $sum: '$revenue' },
      pointsIssued: { $sum: '$pointsIssued' },
    } },
  ]);
  if (!agg.length) return { currency: await getCurrency(), promotions: [] };

  const [promotions, currency] = await Promise.all([
    Promotion.find({ _id: { $in: agg.map(a => a._id) } }),
    getCurrency(),
  ]);
  const nameById = Object.fromEntries(promotions.map(p => [p._id.toString(), p.name]));

  const ranked = agg.map(a => ({
    promotionId: a._id,
    name: nameById[a._id.toString()] || 'Unknown',
    sent: a.sent,
    ordered: a.ordered,
    revenue: +a.revenue.toFixed(2),
    pointsIssued: a.pointsIssued,
    conversionRate: a.sent > 0 ? +((a.ordered / a.sent) * 100).toFixed(1) : 0,
  }));

  const sortKey = metric === 'conversionRate' ? 'conversionRate' : metric === 'ordered' ? 'ordered' : 'revenue';
  ranked.sort((x, y) => y[sortKey] - x[sortKey]);
  return { currency, promotions: ranked.slice(0, limit) };
}

// "Who hasn't ordered in over a month?" as an ad-hoc query — distinct from the
// Win-Back *flow's* enrollment mechanism (utils/flowTriggers/inactiveCustomer.js),
// which reuses this exact stale-customer aggregation shape but gates eligibility
// against FlowEnrollment state for one specific flow. This is just the list.
async function listInactiveCustomers({ days = 60, workspaceId } = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stale = await Order.aggregate([
    { $match: { ...workspaceMatch(workspaceId), status: { $ne: 'cancelled' } } },
    { $group: { _id: '$customer', lastOrderAt: { $max: '$createdAt' } } },
    { $match: { lastOrderAt: { $lt: cutoff } } },
  ]);
  if (!stale.length) return { days, customers: [] };

  const lastOrderById = Object.fromEntries(stale.map(s => [s._id.toString(), s.lastOrderAt]));
  const customers = await Customer.find(withWorkspace({ _id: { $in: stale.map(s => s._id) }, optedOut: { $ne: true }, isDemo: { $ne: true } }, workspaceId));

  return {
    days,
    customers: customers.map(c => ({
      id: c._id, name: `${c.firstname} ${c.lastname}`.trim(), phone: c.phone,
      lastOrderAt: lastOrderById[c._id.toString()],
    })),
  };
}

async function createOrder({ customerId, items, shippingAddress, workspaceId }) {
  const customer = await Customer.findOne(scopedFilter(customerId, workspaceId));
  if (!customer) throw new Error('Customer not found');

  const address = shippingAddress || customer.address;
  if (!address) throw new Error('No shipping address on file for this customer — pass shippingAddress or update the customer first.');
  if (shippingAddress && shippingAddress !== customer.address) {
    customer.address = shippingAddress;
    await customer.save();
  }

  const cartItems = [];
  for (const { productId, quantity = 1 } of items) {
    const product = await Product.findOne(scopedFilter(productId, workspaceId));
    if (!product) throw new Error(`Product ${productId} not found`);
    for (let i = 0; i < quantity; i++) {
      cartItems.push({ name: product.name, priceAud: product.basePrice, pointsCost: 0, description: product.description || product.category || '' });
    }
  }

  const currency = await getCurrency();
  const subtotal = +cartItems.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
  const total = +(subtotal + SHIPPING_COST).toFixed(2);

  const pi = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: { buyerPhone: customer.phone, subtotal: String(subtotal), shippingCost: String(SHIPPING_COST), address, ...stripeWorkspaceMeta(workspaceId || customer.workspaceId) },
  });

  // Visible in the dashboard immediately as pending — the Stripe webhook updates
  // this same document (matched by stripePaymentIntentId) to paid/failed rather
  // than creating a second one.
  await Order.create({
    customer: customer._id,
    workspaceId: workspaceId || customer.workspaceId,
    items: cartItems.map(it => ({ productName: it.name, category: it.description || 'General', quantity: 1, unitPrice: it.priceAud })),
    subtotal, shippingCost: SHIPPING_COST, shippingAddress: address, total,
    status: 'pending', paymentStatus: 'pending', source: 'manual',
    stripePaymentIntentId: pi.id,
  });

  // Shared with routes/pay.js and the Stripe webhook in server.js — this is what lets
  // payment_intent.succeeded update the Order above with the final payment state.
  carts.set(customer.phone, cartItems);

  const summary = cartItems.map((it, i) => `${i + 1}. ${it.name} — ${money(it.priceAud, currency)}`).join('\n');
  await sendUtilityMessageWithConsentAsk({
    customer, workspaceId,
    localized: { key: 'senders.orderSummary', values: () => require('./localization/senderValues').orderSummaryValues({ workspaceId: workspaceId || customer.workspaceId, items, cartItems, subtotal, shipping: SHIPPING_COST, total, currency, address, link: `${APP_URL}/pay/${pi.id}` }) },
    body: `🛒 *Your Order Summary*\n\n${summary}\n\nSubtotal: ${money(subtotal, currency)}\nShipping: ${money(SHIPPING_COST, currency)}\n*Total: ${money(total, currency)}*\n\n📍 Delivering to:\n${address}\n\nPay securely:\n${APP_URL}/pay/${pi.id}`,
  });

  return { success: true, paymentIntentId: pi.id, paymentLink: `${APP_URL}/pay/${pi.id}`, subtotal, shippingCost: SHIPPING_COST, total, itemCount: cartItems.length };
}

async function getPaymentStatus({ paymentIntentId }) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  return { id: pi.id, status: pi.status, amount: pi.amount / 100, currency: pi.currency, buyerPhone: pi.metadata?.buyerPhone || null };
}

// ─── Promotions ──────────────────────────────────────────────────────────────

// What the list/detail views need to show the state of a custom message (and the "now approved" notice) without another request.
const ENTRY_NODE_STATUS_FIELDS = 'templateStatus templateVersion templateRejectedReason templateApprovedAt';

async function listPromotions({ isDemo, workspaceId } = {}) {
  const filter = withWorkspace({}, workspaceId);
  if (isDemo !== undefined) filter.isDemo = isDemo === true || isDemo === 'true';
  return Promotion.find(filter)
    .populate('products', 'name basePrice images').populate('services', 'name basePrice duration')
    .populate('entryNodeId', ENTRY_NODE_STATUS_FIELDS) // lets the list view show template status with no extra round-trip
    .sort({ createdAt: -1 });
}

async function getPromotion({ id, workspaceId }) {
  const promo = await Promotion.findOne(scopedFilter(id, workspaceId))
    .populate('products', 'name basePrice images category description').populate('services')
    .populate('entryNodeId', ENTRY_NODE_STATUS_FIELDS);
  if (!promo) throw new Error('Promotion not found');
  return promo;
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Every id a client sends that points at ANOTHER document (a product on a promotion, a message of a flow, a follow-up of a button,
// the slot of a reschedule) must belong to the caller's own workspace: ids are guessable, and an unchecked one would read or change
// another customer's data. Callers without a workspace (MCP / GPT Actions / tests, which are pinned to one) are unchanged. The
// refusal never says whether the id exists elsewhere.
async function assertOwned(Model, ids, workspaceId, what) {
  if (!workspaceId) return;
  const list = [...new Set((Array.isArray(ids) ? ids : [ids])
    .filter(v => v !== undefined && v !== null && v !== '')
    .map(v => String(v && v._id ? v._id : v)))];
  if (!list.length) return;
  if (list.some(id => !OBJECT_ID_RE.test(id))) throw badRequest(`${what}: not a valid id`, 'INVALID_ID');
  const found = await Model.countDocuments({ _id: { $in: list }, workspaceId });
  if (found !== list.length) throw badRequest(`${what} not found`, 'NOT_FOUND_IN_WORKSPACE');
}

// Fields of a promotion the client may not write directly, and the rules that keep a consent request sendable.
//  - sendRequest is written only by the send gate / the approval notice (and dismissed through dismissSendRequest).
//  - consentWordingAck: whatever the client sends, `at` and `by` are the server's (now / the signed-in user); only the hash
//    of the acknowledged wording is taken from the client. Re-sending the same hash keeps the original acknowledgement.
//  - an entry message that belongs to another workspace can never be attached.
//  - a consent request goes out as separate messages (the carousel format has no opt-in buttons).
async function guardPromotionInput(data, { workspaceId, userId, existing } = {}) {
  delete data.sendRequest;
  delete data.isDemo; // demo promotions (which skip the consent gate) come from the seed script only, never from a request
  for (const key of Object.keys(data)) if (key.startsWith('$')) delete data[key];
  if (data.consentWordingAck !== undefined) {
    const ack = data.consentWordingAck;
    delete data.consentWordingAck;
    if (ack) {
      const textHash = (typeof ack === 'object' && ack.textHash) ? String(ack.textHash).slice(0, 128) : '';
      const same = existing && existing.consentWordingAck && (existing.consentWordingAck.textHash || '') === textHash && existing.consentWordingAck.at;
      if (!same) data.consentWordingAck = { at: new Date(), by: OBJECT_ID_RE.test(String(userId || '')) ? String(userId) : undefined, textHash };
    }
  }
  const purpose = data.purpose !== undefined ? data.purpose : existing && existing.purpose;
  const sendFormat = data.sendFormat !== undefined ? data.sendFormat : existing && existing.sendFormat;
  if (purpose === 'consent_request' && sendFormat === 'carousel') {
    throw new Error('A consent request is sent as separate messages, not as a carousel.');
  }
  if (data.entryNodeId && workspaceId && OBJECT_ID_RE.test(String(data.entryNodeId))) {
    const node = await MessageNode.findById(data.entryNodeId, 'workspaceId');
    if (node && node.workspaceId && String(node.workspaceId) !== String(workspaceId)) {
      throw new Error('That message does not belong to this workspace.');
    }
  }
  return data;
}

// Accepts either the raw Mongoose field names (products/services — what the dashboard
// sends) or productIds/serviceIds (the MCP/GPT tool convention) so both callers work.
async function createPromotion({ productIds, serviceIds, products, services, userId, ...data }) {
  await assertOwned(Product, products ?? productIds, data.workspaceId, 'A product of this promotion');
  await assertOwned(Service, services ?? serviceIds, data.workspaceId, 'A service of this promotion');
  await guardPromotionInput(data, { workspaceId: data.workspaceId, userId });
  return Promotion.create({
    ...data,
    products: products ?? productIds ?? [],
    services: services ?? serviceIds ?? [],
  });
}

async function updatePromotion({ id, workspaceId, productIds, serviceIds, products, services, userId, ...data }) {
  const finalProducts = products ?? productIds;
  const finalServices = services ?? serviceIds;
  await assertOwned(Product, finalProducts, workspaceId, 'A product of this promotion');
  await assertOwned(Service, finalServices, workspaceId, 'A service of this promotion');
  if (finalProducts) data.products = finalProducts;
  if (finalServices) data.services = finalServices;
  // The stored promotion is read only when a rule needs it (the carousel check, an acknowledgement that may be unchanged).
  const needsExisting = data.consentWordingAck !== undefined || data.sendFormat === 'carousel' || data.purpose !== undefined;
  const existing = needsExisting ? await Promotion.findOne(scopedFilter(id, workspaceId)).lean() : null;
  await guardPromotionInput(data, { workspaceId, userId, existing });
  const promo = await Promotion.findOneAndUpdate(scopedFilter(id, workspaceId), data, { new: true, runValidators: true });
  if (!promo) throw new Error('Promotion not found');
  return promo;
}

// "Dismiss" on the "your message was approved, you can now send" notice: the intended send stays on record, the screen stops
// offering it. A promotion with no send request is returned as it is.
async function dismissSendRequest({ promotionId, workspaceId }) {
  await Promotion.updateOne(
    scopedFilter(promotionId, workspaceId, { 'sendRequest.requestedAt': { $exists: true } }),
    { $set: { 'sendRequest.dismissedAt': new Date() } },
  );
  return getPromotion({ id: promotionId, workspaceId }); // unknown / other workspace's promotion -> 'Promotion not found'
}

async function deletePromotion({ id, workspaceId }) {
  const promotion = await Promotion.findOne(scopedFilter(id, workspaceId));
  if (!promotion) throw new Error('Promotion not found');
  // Mirrors deleteFlow's cascade — a custom entry message's whole branching
  // subtree becomes unreachable garbage otherwise (see deleteMessageNodeSubtree).
  if (promotion.entryNodeId) await deleteMessageNodeSubtree(promotion.entryNodeId, workspaceId);
  await Promotion.deleteOne({ _id: promotion._id });
  return { success: true };
}

// Which customers the targeting view lists. No audience = what it always listed (everyone who has not opted out). A consent
// request defaults to the customers who have not answered yet, and never lists opted-out customers (null = list nobody).
function recommendedAudienceFilter(promotion, audience) {
  let status = normalizeConsentFilter(audience);
  const consentRequest = promotion.purpose === 'consent_request';
  if (!status && consentRequest) status = 'not_responded';
  if (status === 'opted_out' && consentRequest) return null;
  return status ? consentQueryFor(status) : { optedOut: { $ne: true } };
}

// RFM (recency/frequency/monetary + category-affinity) scoring — weighted
// 0.30/0.25/0.30/0.15, matching the algorithm merchants see on the dashboard.
async function getRecommendedCustomers({ promotionId, limit = 100, workspaceId, audience }) {
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products', 'category');
  if (!promotion) throw new Error('Promotion not found');
  const audienceFilter = recommendedAudienceFilter(promotion, audience);
  if (!audienceFilter) return [];

  const topN = limit;
  const targetCategories = promotion.type === 'specific_products'
    ? [...new Set(promotion.products.map(p => p.category))]
    : [];

  const stats = await Order.aggregate([
    { $match: { ...workspaceMatch(workspaceId), status: { $ne: 'cancelled' } } },
    { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
    { $group: {
      _id: '$customer',
      orderCount:   { $sum: 1 },
      totalSpent:   { $sum: '$total' },
      lastOrderAt:  { $max: '$createdAt' },
      categories:   { $addToSet: '$items.category' },
    }},
  ]);

  // getRecommendedCustomers is the regular Promotions screen's targeting view
  // only (the dedicated /demo page fetches isDemo:true customers directly) —
  // seeded demo customers must never surface here, so a merchant doesn't have
  // fake data blended into their real campaign targeting.
  if (promotion.customerType === 'points') {
    const all = await Customer.find(withWorkspace({ ...audienceFilter, isDemo: { $ne: true } }, workspaceId)).sort({ loyaltyPoints: -1 }).limit(topN).lean();
    return all.map(c => ({
      ...c, rfmScore: 0, segment: 'Best customers to target', orderCount: 0, totalSpent: 0,
      hasEnoughPoints: c.loyaltyPoints >= (promotion.pointsPrice || 0),
    }));
  }

  // Every opted-in customer is a candidate, not just ones with order history.
  // Previously this scored/ranked only customers appearing in `stats` (i.e.
  // ≥1 non-cancelled order), so a brand-new or freshly-imported customer with
  // zero orders could never be recommended for a cash promotion — silently and
  // permanently invisible in the send panel regardless of the limit (DEFECT-04B).
  // Order-less customers now score 0 (no signal) and rank last, but remain
  // selectable.
  const allCustomers = await Customer.find(withWorkspace({ ...audienceFilter, isDemo: { $ne: true } }, workspaceId), '_id').lean();
  if (!allCustomers.length) return [];

  const statsMap  = Object.fromEntries(stats.map(s => [s._id.toString(), s]));
  const now       = Date.now();
  const maxDays   = stats.length ? Math.max(...stats.map(s => (now - new Date(s.lastOrderAt)) / 86400000)) : 1;
  const maxOrders = stats.length ? Math.max(...stats.map(s => s.orderCount)) : 1;
  const maxSpent  = stats.length ? Math.max(...stats.map(s => s.totalSpent)) : 1;

  const scored = allCustomers.map(c => {
    const s = statsMap[c._id.toString()];
    if (!s) return { customerId: c._id, rfmScore: 0, recency: 0, frequency: 0, monetary: 0, orderCount: 0, totalSpent: 0 };

    const daysSince = (now - new Date(s.lastOrderAt)) / 86400000;
    const recency   = 1 - daysSince / (maxDays || 1);
    const frequency = s.orderCount / (maxOrders || 1);
    const monetary  = s.totalSpent / (maxSpent || 1);

    let affinity = 0;
    if (targetCategories.length > 0 && s.categories?.length) {
      const hits = targetCategories.filter(cat => s.categories.includes(cat)).length;
      affinity = hits / targetCategories.length;
    }

    const rfmScore = 0.30 * recency + 0.25 * frequency + 0.30 * monetary + 0.15 * affinity;
    return { customerId: c._id, rfmScore, recency, frequency, monetary, orderCount: s.orderCount, totalSpent: s.totalSpent };
  });

  scored.sort((a, b) => b.rfmScore - a.rfmScore);
  const topIds = scored.slice(0, topN).map(s => s.customerId);
  const scoreMap = Object.fromEntries(scored.map(s => [s.customerId.toString(), s]));

  const customers = await Customer.find({ _id: { $in: topIds }, ...audienceFilter }).lean();
  const enriched = customers.map(c => {
    const s = scoreMap[c._id.toString()];
    return {
      ...c,
      rfmScore:   +(s?.rfmScore * 100).toFixed(1),
      segment:    segmentFor(s),
      orderCount: s?.orderCount ?? 0,
      totalSpent: +(s?.totalSpent ?? 0).toFixed(2),
    };
  });
  enriched.sort((a, b) => b.rfmScore - a.rfmScore);

  return enriched;
}

// Turns the raw recency/frequency/monetary sub-scores (0-1, relative to this
// customer pool) into one merchant-friendly label instead of a raw RFM number.
// Order matters — most specific match wins:
//   1. Gone quiet, but used to be a good customer  -> win-back candidate
//   2. Gone quiet, never really engaged            -> just inactive
//   3. Still active, spends often and a lot         -> high-value
//   4. Everyone else worth targeting                -> general recommendation
const RFM_HIGH = 0.6;
const RFM_LOW  = 0.35;
function segmentFor(s) {
  if (!s) return 'Best customers to target';
  const { recency, frequency, monetary } = s;
  if (recency < RFM_LOW) {
    return (frequency >= RFM_HIGH || monetary >= RFM_HIGH) ? 'Customers likely to return' : 'Inactive customers';
  }
  if (monetary >= RFM_HIGH && frequency >= RFM_HIGH) return 'High-value customers';
  return 'Best customers to target';
}

// Same "what items does this promotion cover" resolution used by sending,
// previewing, and test-sending — store-wide/no-explicit-picks promotions fall
// back to the first 10 active products/services.
async function resolvePromoItems(promotion) {
  // A store-wide/no-explicit-picks promotion's fallback must stay within its
  // own workspace's catalog — otherwise it'd pull in every other workspace's
  // active products/services too.
  if (promotion.scope === 'services') {
    return promotion.services?.length ? promotion.services : Service.find(withWorkspace({ active: true }, promotion.workspaceId)).limit(10);
  }
  return promotion.products?.length ? promotion.products : Product.find(withWorkspace({ active: true }, promotion.workspaceId)).limit(10);
}

async function previewPromotionMessage({ promotionId, workspaceId }) {
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const items = await resolvePromoItems(promotion);
  const sampleCustomer = {}; // generic — matches what a customer with no name on file would see

  // A merchant-configured custom entry message takes priority over the fixed
  // default, previewed regardless of Meta-approval status — unlike an actual
  // send (resolveApprovedEntryNode), a preview must reflect what's configured
  // immediately after saving, not just once Meta has approved it.
  const consentRequest = isConsentRequest(promotion);
  if (promotion.entryNodeId) {
    const entryNode = await loadEntryNode(promotion);
    if (entryNode) {
      const params = await buildPromoEntryNodeParams(sampleCustomer, promotion, items);
      let body = entryNode.bodyText;
      params.forEach((val, i) => { body = body.split(`{{${i + 1}}}`).join(val); });
      return {
        messageType: 'interactive',
        body,
        buttonLabel: entryNode.buttons[0]?.label || null,
        templateStatus: entryNode.templateStatus,
        isCustomEntryNode: true, // no Opt Out button here — this is the merchant's own message tree
        // Everything the customer will see: every button (with what a tap does) and the footer WhatsApp adds.
        buttons: [...entryNode.buttons].sort((a, b) => a.position - b.position).map(b => ({
          position: b.position, label: b.label, action: b.nextAction?.type || 'end_flow', replyText: b.nextAction?.replyText || null,
        })),
        footer: entryNode.templateSnapshot?.footer || TEMPLATE_FOOTER,
        isConsentRequest: consentRequest,
        templateVersion: entryNode.templateVersion ?? null,
        templateRejectedReason: entryNode.templateRejectedReason || null,
        templateApprovedAt: entryNode.templateApprovedAt || null,
      };
    }
  }
  // A consent request has no built-in message to fall back to: it only exists as the merchant's own message.
  if (consentRequest) {
    return {
      messageType: 'interactive', body: '', buttonLabel: null, buttons: [], footer: TEMPLATE_FOOTER, templateStatus: null,
      isCustomEntryNode: false, isConsentRequest: true, needsMessage: true,
    };
  }

  if (promotion.customerType === 'points') {
    const { interactive, textFallback } = buildPointsPromoPayload(sampleCustomer, promotion, items);
    return {
      messageType: 'interactive',
      body: interactive.body.text,
      buttonLabel: interactive.action.buttons[0].reply.title,
      fallbackText: textFallback,
    };
  }

  const interactive = buildPromoAnnouncementPayload(sampleCustomer, promotion, items);
  return {
    messageType: 'interactive',
    body: interactive.body.text,
    header: interactive.header?.image?.link || null,
    buttonLabel: interactive.action.buttons[0].reply.title,
  };
}

// A test message goes to any number the merchant types, from the shared WhatsApp number every customer of the platform relies on
// (its quality rating, its Meta bill): it is limited per customer per hour (TEST_SEND_LIMIT_PER_HOUR, default 30, 0 = no limit),
// and never goes to the number of a customer of this workspace who opted out or was erased.
const TEST_SEND_WINDOW_MS = 60 * 60 * 1000;
const testSends = new Map(); // workspaceId -> times of the test sends of the last hour (per process)
function testSendLimit() {
  const n = Number(process.env.TEST_SEND_LIMIT_PER_HOUR);
  return process.env.TEST_SEND_LIMIT_PER_HOUR !== undefined && String(process.env.TEST_SEND_LIMIT_PER_HOUR).trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 30;
}
function takeTestSendSlot(workspaceId) {
  const limit = testSendLimit();
  if (!limit) return;
  const key = String(workspaceId || 'none');
  const now = Date.now();
  const recent = (testSends.get(key) || []).filter(t => now - t < TEST_SEND_WINDOW_MS);
  if (recent.length >= limit) {
    testSends.set(key, recent);
    throw typedError(`You have already sent ${limit} test messages in the last hour. Please wait a little before sending more.`, { code: 'TEST_SEND_LIMIT', status: 429 });
  }
  recent.push(now);
  testSends.set(key, recent);
}
async function refuseTestSendToOptedOut(phone, workspaceId) {
  try {
    const digits = String(phone).replace(/\D/g, '').replace(/^00/, '');
    if (!digits) return;
    const row = await Customer.findOne(withWorkspace({
      phone: { $in: [String(phone), digits, `+${digits}`, `00${digits}`] },
      $or: [{ optedOut: true }, { deletedAt: { $exists: true } }],
    }, workspaceId)).select('_id').lean();
    if (row) throw typedError('This number belongs to a customer who opted out of messages, so no message is sent to it, not even a test.', { code: 'TEST_SEND_REFUSED', status: 409 });
  } catch (err) {
    if (err && err.code === 'TEST_SEND_REFUSED') throw err; // a failing lookup never blocks a test send
  }
}

async function sendTestMessage({ promotionId, phone, workspaceId, userId }) {
  if (!phone) throw new Error('phone required');
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  await refuseTestSendToOptedOut(phone, promotion.workspaceId);
  await requireUsableSender();
  const items = await resolvePromoItems(promotion);
  const testCustomer = { firstname: 'Test', phone, loyaltyPoints: promotion.pointsPrice || 100 };

  // Same routing as sendPromotion below — test-send should show exactly what a real send would use, so a custom message
  // that Meta has not approved yet is blocked (and submitted) here too instead of silently sending the default.
  const entryNode = await resolveEntryNodeForSend({ promotion, userId, forTest: true });
  takeTestSendSlot(promotion.workspaceId || workspaceId); // only a message that is really about to go out counts
  try {
    if (entryNode) {
      const params = await entryNodeParams(testCustomer, promotion, items, entryNode);
      // promotest: instead of promo: for the consent buttons — a tap on a test message must never write consent.
      const buttonPayloads = buildEntryButtonPayloads(entryNode, promotion, { test: true });
      await sendCustomFlowTemplate(phone, entryNode.templateName, params, buttonPayloads);
    } else if (promotion.customerType === 'points') {
      await sendPointsPromoMessage(phone, testCustomer, promotion, items);
    } else {
      // Same 24-hour-window routing as sendPromotion (shared/promoWindow.js): a phone that has not written to the business
      // recently gets the approved template, because the chat-style message would be accepted and then refused by WhatsApp.
      const win = items.length ? await promoWindow.insideWindow({ phones: [phone], workspaceId: promotion.workspaceId }) : null;
      if (win && !win.has(promoWindow.phoneKey(phone))) await sendPromoTemplate(phone, testCustomer, items[0], promotion);
      else await sendPromoAnnouncement(phone, testCustomer, promotion, items);
    }
  } catch (err) {
    // Meta's own reason instead of "Request failed with status code 400". Any other error, and every error when the kill
    // switch is off, is rethrown untouched.
    const info = metaErrorInfo(err);
    if (info.meta) throw new Error(info.message, { cause: err });
    throw err;
  }
  return { success: true };
}

// allowRealDemoSend is a narrow, explicit bypass for the dedicated /demo
// sales-presentation page only (see frontend pages/demo) — a presenter
// deliberately confirms ("this is not a simulation") a real send to their own
// controlled phone so a live prospect sees the actual WhatsApp experience.
// It must never be settable via MCP or GPT Actions (those tool schemas don't
// declare it, so it can never arrive here through those surfaces) — every
// other caller (regular Promotions screen, Automated Flows, API integrations)
// stays fully simulated for isDemo data.
async function sendPromotion({ promotionId, customerIds, allowRealDemoSend = false, workspaceId, userId }) {
  if (!customerIds?.length) throw new Error('customerIds required');
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const requested = await Customer.find(withWorkspace({ _id: { $in: customerIds } }, workspaceId));
  const consentMode = isConsentRequest(promotion);
  // Demo/fake data (this promotion or the customer themselves) is exempt from
  // the consent gate — nothing real ever sends to it regardless (see the
  // `demo` check in the loop below), so requiring consent bookkeeping on
  // synthetic sales-demo data would be pure friction with no compliance benefit.
  // A consent request is the opposite audience: customers who have NOT opted in yet (never opted-out ones, nobody asked
  // within the cooldown) - see splitConsentRequestAudience.
  let customers;
  let skippedOptedOut;
  let skippedNoConsent;
  let consentSkips = null;
  if (consentMode) {
    const split = splitConsentRequestAudience(requested, promotion);
    customers = split.eligible;
    skippedOptedOut = split.skippedOptedOut;
    skippedNoConsent = requested.length - customers.length - split.skippedOptedOut - split.skippedAlreadyOptedIn - split.skippedAskedRecently;
    consentSkips = { skippedAlreadyOptedIn: split.skippedAlreadyOptedIn, skippedAskedRecently: split.skippedAskedRecently };
  } else {
    customers = requested.filter(c => canSendMarketing(c) || promotion.isDemo || c.isDemo);
    skippedOptedOut = requested.filter(c => c.optedOut).length;
    skippedNoConsent = requested.length - customers.length - skippedOptedOut;
  }

  const items = await resolvePromoItems(promotion);
  // DEFECT-02: optional merchant-authored custom entry message + branching. A message Meta has not approved is no longer
  // replaced by the default silently: it is submitted, the request is remembered and the send is refused (typed
  // TEMPLATE_NOT_APPROVED) before any customer is touched. Nothing real is sent for demo data, so only a send that can reach a
  // real customer is gated.
  const realSendPossible = allowRealDemoSend || (!promotion.isDemo && customers.some(c => !c.isDemo));
  if (realSendPossible) await requireUsableSender(); // a customer whose own number is unusable gets ONE clear refusal, not a send loop of failures
  const entryNode = realSendPossible
    ? await resolveEntryNodeForSend({ promotion, requested, userId })
    : await resolveApprovedEntryNode(promotion);
  // Consent requests are English-only for now: the Arabic sender does not know them.
  const loc = consentMode ? null : await localizedRun({ sender: 'promotion', workspaceId: workspaceId || promotion.workspaceId, customers, promotion, items, allowRealDemoSend });
  // Who has written to the business within the last 24 hours (shared/promoWindow.js). Only a cash promotion with something
  // to show can fall back to the approved template, so only then is the lookup needed. null = no answer (kill switch
  // PROMO_DELIVERY_FIX=off, or the lookup failed): every customer takes the unchanged path below.
  const windowSet = (!entryNode && !consentMode && promotion.customerType !== 'points' && items.length)
    ? await promoWindow.insideWindow({ phones: customers.map(c => c.phone), workspaceId: promotion.workspaceId })
    : null;

  let sentCount = 0;
  let demoCount = 0;
  const errors = [];
  for (const customer of customers) {
    const demo = !allowRealDemoSend && !!(promotion.isDemo || customer.isDemo);
    if (demo) demoCount++;
    let sent = false;
    let result = null;
    let messageType = 'interactive';
    let templateName;
    let failReason;
    let failCode;
    let simOutcome = null;
    let consentSnapshot = null; // consent requests: exactly what this customer was shown (written with the CampaignMessage)
    // A consent request claims each customer atomically BEFORE asking: two requests running at the same moment (a second Send after
    // a slow first one, two staff) walk the same audience, and an ask is only ever sent once per cooldown. The claim also re-checks
    // that the person has not opted in or out since the audience was worked out (the loop takes ~300 ms per customer).
    let askClaim = null;
    if (consentMode && !demo) {
      askClaim = await claimConsentAsk(customer, promotion.workspaceId);
      if (!askClaim) { consentSkips.skippedAskedRecently += 1; continue; }
    }
    // Arabic customer of a switched-on merchant: null = the existing path below, unchanged.
    const arabic = (!demo && loc) ? await loc.trySend(customer) : null;
    if (arabic && arabic.skip) continue; // never message this person (same-phone opt-out / template stopped)

    if (demo) {
      // Zero real WhatsApp API calls for demo data — see simulateDemoConversion above.
      result = { messages: [{ id: fakeWamid() }] };
      sent = true; sentCount++;
      simOutcome = await simulateDemoConversion({ customer, promotion, items }).catch(() => null);
    } else if (arabic) {
      // The customer's Arabic version was attempted by loc.trySend; recorded exactly like the entry-node
      // branch below (the CampaignMessage write after the chain is shared). Never retried in English.
      messageType = arabic.messageType; templateName = arabic.templateName; result = arabic.result;
      if (arabic.sent) { sent = true; sentCount++; } else { failReason = arabic.failReason; errors.push({ customer: customer._id, error: arabic.failReason }); }
    } else if (entryNode) {
      // Record which template we're using regardless of send success — a
      // template send validates the template's existence/approval synchronously
      // (unlike an interactive/session message, which Meta accepts even outside
      // the 24h window and only fails asynchronously later), so a throw here
      // must not lose that intent, matching flowScheduler.js#processEnrollment.
      messageType = 'template';
      templateName = entryNode.templateName;
      try {
        const params = await entryNodeParams(customer, promotion, items, entryNode);
        const buttonPayloads = buildEntryButtonPayloads(entryNode, promotion);
        result = await sendCustomFlowTemplate(customer.phone, entryNode.templateName, params, buttonPayloads);
        sent = true; sentCount++;
        if (consentMode) consentSnapshot = buildConsentSnapshot({ promotion, node: entryNode, params, payloads: buttonPayloads });
      } catch (err) {
        const info = metaErrorInfo(err); // Meta's own reason (plain err.message when PROMO_DELIVERY_FIX=off)
        failReason = info.message; failCode = info.code;
        errors.push({ customer: customer._id, error: info.message });
      }
    } else if (windowSet && !windowSet.has(promoWindow.phoneKey(customer.phone))) {
      // Outside the 24-hour window (this customer has not written to the business recently): a chat-style message would be
      // accepted by WhatsApp and then refused (131047) without ever reaching the fallback below. Send the approved template
      // directly. If the template is refused, say so with Meta's own reason (paused, not approved, ...) - falling back to the
      // chat-style message would only be accepted and refused again, and hide that reason behind "24-hour window closed".
      messageType = 'template'; templateName = PROMO_TEMPLATE;
      try {
        result = await sendPromoTemplate(customer.phone, customer, items[0], promotion);
        sentCount++; sent = true;
      } catch (err) {
        const info = metaErrorInfo(err);
        failReason = info.message; failCode = info.code;
        errors.push({ customer: customer._id, error: info.message });
      }
    } else {
      let interactiveErr = null;
      try {
        if (promotion.customerType === 'points') result = await sendPointsPromoMessage(customer.phone, customer, promotion, items);
        else result = await sendPromoAnnouncement(customer.phone, customer, promotion, items);
        sent = true; sentCount++;
      } catch (e) { interactiveErr = e; /* fall through to template fallback */ }

      if (!sent && promotion.customerType !== 'points' && items.length) {
        try {
          result = await sendPromoTemplate(customer.phone, customer, items[0], promotion);
          sentCount++; sent = true; messageType = 'template'; templateName = PROMO_TEMPLATE;
        } catch (err) {
          const info = metaErrorInfo(err);
          failReason = info.message; failCode = info.code;
          errors.push({ customer: customer._id, error: info.message });
        }
      } else if (!sent) {
        failReason = 'Send failed';
        if (interactiveErr) { // no template to fall back to: when Meta itself refused the chat-style message, say why
          const info = metaErrorInfo(interactiveErr); // (no Meta body, or kill switch off: the previous 'Send failed')
          if (info.meta) { failReason = info.message; failCode = info.code; }
        }
        errors.push({ customer: customer._id, error: failReason });
      }
    }

    const campaignRow = {
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: customer.phone,
      workspaceId: promotion.workspaceId,
      wamid: wamidOf(result), messageType, templateName,
      messageNode: (!demo && entryNode) ? entryNode._id : undefined,
      status: sent ? (demo ? 'read' : 'sent') : 'failed',
      sentAt: sent ? new Date() : undefined,
      deliveredAt: demo && sent ? new Date() : undefined,
      readAt: demo && sent ? new Date() : undefined,
      clickedAt: simOutcome ? new Date() : undefined,
      order: simOutcome?.order?._id,
      revenue: simOutcome?.revenue || 0,
      pointsIssued: simOutcome?.pointsIssued || 0,
      statusReason: sent ? undefined : failReason,
      errorCode: sent ? undefined : failCode, // Meta's code when the API call itself was refused (undefined = unchanged row)
      ...(consentSnapshot ? { consentSnapshot } : {}),
    };
    // best-effort — a tracking-write failure shouldn't break the send loop. A consent request is the one exception to
    // "ignore it": without this row a later tap cannot be tied to the customer, so it is tried once more and a second
    // failure is logged.
    await CampaignMessage.create(campaignRow).catch(async (err) => {
      if (!consentSnapshot) return;
      await CampaignMessage.create(campaignRow).catch((err2) => {
        console.error('[sendPromotion] consent request message not recorded for customer', String(customer._id), '-', (err2 || err).message);
      });
    });
    // The customer has now been asked (the claim above stamped marketingConsentAskedAt): another consent request skips them for
    // CONSENT_ASK_COOLDOWN_DAYS. An ask that never went out is given back, so a failed send does not count as asked.
    if (askClaim && !sent) await releaseConsentAsk(customer, promotion.workspaceId, askClaim);
    if (loc) await loc.record(customer, { sent, result, failReason }); // sidecar language row, never throws

    if (!demo) await new Promise(r => setTimeout(r, 300)); // real-send throttle only
  }

  // Best-effort, like the CampaignMessage writes above — the real WhatsApp
  // sends already happened by this point, so a bookkeeping-only failure here
  // must never make the whole call throw. It used to: a transient DB error on
  // this single updateOne turned a real, successful send into a 500 the
  // merchant would read as "nothing sent" and could retry, double-messaging
  // every customer who'd already received it.
  // A send that went through settles the "send it once it is approved" request the merchant left earlier (kept when
  // everything failed, so they can still be told when to try again).
  const postSend = { sentAt: new Date(), sentCount, status: 'active' };
  if (promotion.sendRequest && promotion.sendRequest.requestedAt && (sentCount > 0 || errors.length === 0)) postSend.$unset = { sendRequest: 1 };
  await Promotion.updateOne({ _id: promotion._id }, postSend).catch(err => {
    console.error('[sendPromotion] post-send Promotion update failed:', err.message);
  });
  // demoCount lets callers (esp. AI Mode) tell the merchant when a "successful"
  // send was actually simulated — see the Demo Mode isolation note above.
  return { success: true, sentCount, skippedOptedOut, skippedNoConsent, ...(consentSkips || {}), errors, demoCount, ...(loc ? loc.summary() : {}) };
}

async function sendLoyaltyReminders({ customerIds, workspaceId } = {}) {
  const filter = withWorkspace(customerIds?.length ? { _id: { $in: customerIds } } : { loyaltyPoints: { $gt: 0 } }, workspaceId);
  const requested = await Customer.find(filter);
  // Demo customers are exempt from the consent gate — see sendPromotion's
  // identical reasoning above.
  const customers = requested.filter(c => canSendMarketing(c) || c.isDemo);
  const skippedOptedOut = requested.filter(c => c.optedOut).length;
  const skippedNoConsent = requested.length - customers.length - skippedOptedOut;
  let sentCount = 0;
  let demoCount = 0;
  const loc = await localizedRun({ sender: 'loyalty_reminder', workspaceId, customers });
  for (const c of customers) {
    if (!c.loyaltyPoints) continue;
    const demo = !!c.isDemo;
    if (demo) demoCount++;
    let result = null;
    let sent = false;
    let messageType = 'template';
    let templateName = LOYALTY_TEMPLATE;
    const arabic = (!demo && loc) ? await loc.trySend(c) : null;
    if (arabic && arabic.skip) continue;

    if (demo) {
      // Zero real WhatsApp API calls for demo data — see simulateDemoConversion above.
      result = { messages: [{ id: fakeWamid() }] };
      sent = true; sentCount++;
    } else if (arabic) {
      result = arabic.result; templateName = arabic.templateName; // messageType stays 'template'
      if (arabic.sent) { sent = true; sentCount++; }
    } else {
      try {
        result = await sendLoyaltyTemplate(c.phone, c.firstname, c.loyaltyPoints);
        sent = true; sentCount++;
      } catch {
        try {
          result = await sendLoyaltyReminder(c.phone, c.firstname, c.loyaltyPoints);
          sent = true; sentCount++; messageType = 'interactive'; templateName = undefined;
        } catch (_) {}
      }
    }

    await CampaignMessage.create({
      kind: 'loyalty_reminder', customer: c._id, phone: c.phone,
      workspaceId: c.workspaceId,
      wamid: wamidOf(result), messageType, templateName,
      status: sent ? (demo ? 'read' : 'sent') : 'failed',
      sentAt: sent ? new Date() : undefined,
      deliveredAt: demo && sent ? new Date() : undefined,
      readAt: demo && sent ? new Date() : undefined,
    }).catch(() => {});
    if (loc) await loc.record(c, { sent, result });
    if (!demo) await new Promise(r => setTimeout(r, 300));
  }
  return { success: true, sentCount, skippedOptedOut, skippedNoConsent, demoCount, ...(loc ? loc.summary() : {}) };
}

// ─── Settings ────────────────────────────────────────────────────────────────

// Settings is per-workspace (one doc per workspace). utils/settingsCache.js's getCurrency() (used throughout this file for
// message formatting) reads the Settings of the workspace of the current request / flow sweep (utils/senderContext.js), so each
// customer's messages use their own currency; with no context it still reads the first document, as before.
async function getLoyaltySettings({ workspaceId } = {}) {
  const filter = withWorkspace({}, workspaceId);
  return (await Settings.findOne(filter)) || (await Settings.create(filter));
}

async function updateLoyaltySettings(data, { workspaceId } = {}) {
  const filter = withWorkspace({}, workspaceId);
  let s = (await Settings.findOne(filter)) || new Settings(filter);
  if (data.loyaltyPointsPerUnit != null) s.loyaltyPointsPerUnit = data.loyaltyPointsPerUnit;
  if (data.minPointsPerPurchase != null) s.minPointsPerPurchase = data.minPointsPerPurchase;
  if (data.currency) s.currency = data.currency;
  if (data.flowCooldownDays != null) s.flowCooldownDays = data.flowCooldownDays;
  if (data.merchantName != null) s.merchantName = data.merchantName;
  if (data.defaultCountryCode != null) s.defaultCountryCode = data.defaultCountryCode;
  await s.save();
  settingsCache.invalidate(workspaceId); // that customer's cached settings (a super admin saving for a customer runs in another context)
  return s;
}

// ─── Flows ───────────────────────────────────────────────────────────────────
// Automated lifecycle messaging — see utils/flowScheduler.js for the engine
// that actually enrolls/sends. This section is just CRUD + reporting.

// Per-triggerType sensible defaults, applied at creation (not schema defaults
// — they differ by type). templateName is fixed per type; v1 doesn't let
// merchants author custom copy per flow, matching PROMO_TEMPLATE/LOYALTY_TEMPLATE
// being fixed today.
const FLOW_TYPE_DEFAULTS = {
  inactive_customer:       { inactivityDays: 60, templateName: WINBACK_TEMPLATE },
  post_purchase_points:    { delayHours: 2, templateName: POST_PURCHASE_TEMPLATE },
  points_balance_reminder: { inactivityDays: 30, templateName: POINTS_NUDGE_TEMPLATE },
  booking_no_show:         { delayHours: 1, templateName: NO_SHOW_TEMPLATE },
  // DEFECT-03 §8.1 new metrics — no templateName: these are "promotion-reference
  // only" (createFlow requires promotionId for these two, see below), since
  // there's no generic fixed-copy template that fits an arbitrary points/cash
  // promotion the way the original 4's fixed wording does.
  points_threshold:        { pointsThreshold: 1000 },
  purchase_frequency:      { inactivityDays: 30, orderCountThreshold: 2 },
};

const PROMOTION_ONLY_TRIGGER_TYPES = new Set(['points_threshold', 'purchase_frequency']);

// DEFECT-03 §8.2/§9: "Industry Best Practice" static preset catalog — content
// taken directly from §9 rather than inventing new defaults, organized by the
// same 3 outcome categories. Not every rule in §9 has a real trigger behind it
// yet (e.g. C4's "offer redeem mid-order" is an in-conversation UX feature, not
// a Flow trigger at all; B1's "own historical reorder interval" is exactly the
// §8.2 AI Recommendations concept, explicitly deferred as a fast-follow rather
// than shipped as a fake static number). `flowConfig` is only present for
// presets backed by a real, working trigger type — the frontend uses its
// absence to show a preset as informational ("not yet available") instead of
// offering an Apply action that would silently do the wrong thing.
const FLOW_PRESET_CATALOG = [
  // §9.1 — Drive Repeat Business
  { id: 'A1', category: 'repeat_business', rule: 'days_since_last_order > 30', action: 'Send Win-Back Promotion (soft)', why: 'Standard first-touch reactivation.',
    flowConfig: { triggerType: 'inactive_customer', inactivityDays: 30 } },
  { id: 'A2', category: 'repeat_business', rule: 'days_since_last_order > 60 (and A1 didn\'t convert)', action: 'Send Win-Back Promotion (stronger offer)', why: 'A single win-back message underperforms a staggered sequence — escalate the incentive as inactivity deepens.',
    flowConfig: { triggerType: 'inactive_customer', inactivityDays: 60, requiresPriorPresetId: 'A1' } },
  { id: 'A3', category: 'repeat_business', rule: 'days_since_last_order > 90 (and A2 didn\'t convert)', action: 'Send "Last Chance" Promotion, largest incentive', why: 'Final attempt before treating the customer as churned.',
    flowConfig: { triggerType: 'inactive_customer', inactivityDays: 90, requiresPriorPresetId: 'A2' } },
  { id: 'A4', category: 'repeat_business', rule: 'order_count = 1 and days_since_first_order > 5', action: 'Send Second-Purchase Nudge Promotion', why: 'The 1st-to-2nd-purchase transition is the strongest predictor of whether a customer becomes repeat at all — deserves a more generous, dedicated offer.' },
  { id: 'A5', category: 'repeat_business', rule: 'booking_status = completed and days_since_booking > [service-typical rebook cycle]', action: 'Send Rebooking Reminder Promotion', why: 'For services, timing the nudge to the natural rebook cycle (e.g. ~4 weeks for a haircut) outperforms a generic fixed delay.' },
  { id: 'A6', category: 'repeat_business', rule: 'order_started = true and payment_completed = false for > 1 hour', action: 'Send Abandoned Order Recovery Promotion', why: 'Classic cart-abandonment recovery; converts best within hours, not days.' },
  // §9.2 — Increase Customer Lifetime Value
  { id: 'B1', category: 'lifetime_value', rule: 'days_since_last_order approaching the customer\'s own historical average reorder interval, not yet lapsed', action: 'Send "Usual Order" Reminder Promotion', why: 'Pre-emptive and personalized — reaches the customer just before they\'d naturally go quiet.' },
  { id: 'B2', category: 'lifetime_value', rule: 'lifetime_spend >= [merchant-defined VIP threshold]', action: 'Move to VIP segment + send perk-unlock Promotion', why: 'Retaining top spenders matters disproportionately versus average customers.' },
  { id: 'B3', category: 'lifetime_value', rule: 'order_count >= [5] (a proven repeat customer)', action: 'Send Referral Prompt Promotion', why: 'Referred customers tend toward higher LTV; asking after proven satisfaction (not on order #1) improves response — ties to the "viral loop" mechanic flagged earlier in the project.' },
  { id: 'B4', category: 'lifetime_value', rule: 'days_since_signup = 365, or order_count crosses a round milestone (e.g. 10th order)', action: 'Send Anniversary/Milestone Promotion', why: 'Recognition drives emotional loyalty and gives a natural excuse to re-engage with an offer.' },
  // §9.3 — Increase Loyalty Redemption Rates
  { id: 'C1', category: 'redemption', rule: 'points_balance unused for > [X] days', action: 'Points Balance Reminder Promotion (already built)', why: 'Unused points are dead value — a large share of loyalty programs industry-wide have points nobody ever redeems.',
    flowConfig: { triggerType: 'points_balance_reminder', inactivityDays: 30 } },
  { id: 'C2', category: 'redemption', rule: 'points_balance within [10-20]% of next reward threshold', action: '"Almost There" Nudge Promotion', why: 'The goal-gradient effect — people are measurably more motivated to act the closer they perceive themselves to a goal; a high-ROI mechanic most programs never implement.' },
  { id: 'C3', category: 'redemption', rule: 'points_earned for the first time ever', action: 'Loyalty Program Explainer Promotion', why: 'Much of the "dead balance" problem is customers who never understood the redemption mechanic, not customers who didn\'t care.',
    flowConfig: { triggerType: 'points_threshold', pointsThreshold: 1 } },
  { id: 'C4', category: 'redemption', rule: 'points_balance >= redemption_threshold and order_started = true', action: 'Proactively offer "Redeem Now" as a button inside the live order flow', why: 'Redemption should be offered at the point of highest intent — mid-order, not just via a separate reminder.' },
  { id: 'C5', category: 'redemption', rule: 'Immediately after a redemption completes', action: 'Send Thank-You + "Here\'s how to earn your next reward" Promotion', why: 'Redemption shouldn\'t be a dead end — closing the loop back into further earning sustains the cycle.' },
];

function getFlowPresets() {
  return FLOW_PRESET_CATALOG.map(p => ({ ...p, buildable: !!p.flowConfig }));
}

// Sample {{n}} substitutions for previewFlowMessage — realistic stand-ins for
// what a real send would fill in (customer first name, points balance, service
// name). Flow template bodies are fixed per triggerType, not per-flow (unlike
// Promotion), so preview only needs a triggerType — the create/edit modal can
// show it before the flow is even saved.
const FLOW_PREVIEW = {
  inactive_customer:       { body: WINBACK_BODY, values: ['Alex'], buttonLabel: 'Shop Now' },
  post_purchase_points:    { body: POST_PURCHASE_BODY, values: ['Alex', '250'], buttonLabel: 'Shop Now' },
  points_balance_reminder: { body: POINTS_NUDGE_BODY, values: ['Alex', '250'], buttonLabel: 'Shop Now' },
  booking_no_show:         { body: NO_SHOW_BODY, values: ['Alex', 'Haircut'], buttonLabel: 'Rebook Free' },
};

async function previewFlowMessage({ triggerType }) {
  const preview = FLOW_PREVIEW[triggerType];
  if (!preview) throw new Error('Unknown or not-yet-supported triggerType');
  const body = preview.values.reduce((text, val, i) => text.split(`{{${i + 1}}}`).join(val), preview.body);
  return {
    messageType: 'template',
    templateName: FLOW_TYPE_DEFAULTS[triggerType].templateName,
    body,
    buttonLabel: preview.buttonLabel,
  };
}

async function listFlows({ status, workspaceId } = {}) {
  const filter = withWorkspace({}, workspaceId);
  if (status) filter.status = status;
  // Populated (not just the id) so the frontend can grey out Activate for a
  // flow whose custom entry template isn't approved yet, without a second
  // round-trip per flow — mirrors the activateFlow guard below. promotionId's
  // entryNodeId needs its own populate (Mongoose doesn't do nested populate
  // through a ref by default) for the same reason.
  return Flow.find(filter).sort({ createdAt: -1 })
    .populate('entryNodeId', 'templateStatus')
    .populate({ path: 'promotionId', select: 'name entryNodeId', populate: { path: 'entryNodeId', select: 'templateStatus' } })
    .populate('requiresPriorFlowId', 'name');
}

async function getFlow({ id, workspaceId }) {
  const flow = await Flow.findOne(scopedFilter(id, workspaceId))
    .populate('entryNodeId', 'templateStatus')
    .populate({ path: 'promotionId', select: 'name entryNodeId', populate: { path: 'entryNodeId', select: 'templateStatus' } })
    .populate('requiresPriorFlowId', 'name');
  if (!flow) throw new Error('Flow not found');
  return flow;
}

// An "Ask customers to opt in" promotion (Promotion.purpose = consent_request) is sent by hand to the customers who have not
// answered yet; an automated flow only ever messages customers who already opted in, so the two never belong together.
const CONSENT_REQUEST_IN_FLOW = 'An "Ask customers to opt in" promotion cannot be used in an automated flow: it is sent by hand to customers who have not answered yet. Pick a normal promotion.';
async function refuseConsentRequestInFlow(promotionId, workspaceId) {
  if (!promotionId) return;
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).select('purpose').lean().catch(() => null);
  if (promotion && promotion.purpose === 'consent_request') throw new Error(CONSENT_REQUEST_IN_FLOW);
}

async function createFlow({
  name, triggerType, inactivityDays, delayHours, cooldownDaysOverride,
  pointsThreshold, orderCountThreshold, promotionId, requiresPriorFlowId, workspaceId,
}) {
  const defaults = FLOW_TYPE_DEFAULTS[triggerType];
  if (!defaults) throw new Error('Unknown or not-yet-supported triggerType');
  // DEFECT-03: these two new metrics have no fixed default template — a
  // reference to an (eventually approved) Promotion is the only way they can
  // ever send anything, so it must be provided up front rather than
  // discovered missing at first send.
  if (PROMOTION_ONLY_TRIGGER_TYPES.has(triggerType) && !promotionId) {
    throw new Error('This trigger type requires referencing a Promotion — pick one to continue.');
  }
  await assertOwned(Promotion, promotionId, workspaceId, 'That promotion');
  await assertOwned(Flow, requiresPriorFlowId, workspaceId, 'The earlier flow');
  await refuseConsentRequestInFlow(promotionId, workspaceId);
  return Flow.create({
    name,
    triggerType,
    workspaceId,
    inactivityDays: inactivityDays ?? defaults.inactivityDays,
    delayHours: delayHours ?? defaults.delayHours,
    pointsThreshold: pointsThreshold ?? defaults.pointsThreshold,
    orderCountThreshold: orderCountThreshold ?? defaults.orderCountThreshold,
    templateName: defaults.templateName,
    cooldownDaysOverride,
    promotionId: promotionId || undefined,
    requiresPriorFlowId: requiresPriorFlowId || undefined,
  });
}

async function updateFlow({ id, workspaceId, ...data }) {
  delete data.triggerType;   // fixed at creation — changing it invalidates templateName/eligibility semantics
  delete data.templateName;
  for (const key of Object.keys(data)) if (key.startsWith('$')) delete data[key]; // an update operator would bypass the checks below
  await assertOwned(Promotion, data.promotionId, workspaceId, 'That promotion');
  await assertOwned(Flow, data.requiresPriorFlowId, workspaceId, 'The earlier flow');
  await assertOwned(MessageNode, data.entryNodeId, workspaceId, 'That message');
  await refuseConsentRequestInFlow(data.promotionId, workspaceId);
  const flow = await Flow.findOneAndUpdate(scopedFilter(id, workspaceId), data, { new: true, runValidators: true });
  if (!flow) throw new Error('Flow not found');
  return flow;
}

async function activateFlow({ id, workspaceId }) {
  const flow = await Flow.findOne(scopedFilter(id, workspaceId));
  if (!flow) throw new Error('Flow not found');
  if (flow.promotionId) {
    // DEFECT-03: a Flow referencing a Promotion can only go live once that
    // Promotion has its own approved custom message (DEFECT-02) — same
    // reasoning as the legacy entryNodeId guard below: an unapproved template
    // would silently burn enrollments with no retry.
    const promotion = await Promotion.findById(flow.promotionId);
    if (promotion && promotion.purpose === 'consent_request') throw new Error(CONSENT_REQUEST_IN_FLOW);
    const node = promotion?.entryNodeId ? await MessageNode.findById(promotion.entryNodeId) : null;
    if (!node || node.templateStatus !== 'approved') {
      throw new Error("This flow's referenced promotion needs an approved custom message before it can be activated.");
    }
  } else if (flow.entryNodeId) {
    // processEnrollment marks a FlowEnrollment 'messaged' (terminal) before the
    // send is attempted — an unapproved template would silently burn enrollments
    // with no retry, so activation is blocked until Meta has approved it.
    const node = await MessageNode.findById(flow.entryNodeId);
    if (!node || node.templateStatus !== 'approved') {
      throw new Error("This flow's custom entry message needs an approved WhatsApp template before it can be activated.");
    }
  }
  flow.status = 'active';
  await flow.save();
  return flow;
}

async function pauseFlow({ id, workspaceId }) {
  const flow = await Flow.findOneAndUpdate(scopedFilter(id, workspaceId), { status: 'paused' }, { new: true });
  if (!flow) throw new Error('Flow not found');
  return flow;
}

async function deleteFlow({ id, workspaceId }) {
  const flow = await Flow.findOne(scopedFilter(id, workspaceId));
  if (!flow) throw new Error('Flow not found');
  if (flow.entryNodeId) await deleteMessageNodeSubtree(flow.entryNodeId, workspaceId);
  await Flow.deleteOne({ _id: flow._id });
  return { success: true };
}

async function listFlowEnrollments({ flowId, page = 1, limit = 50, workspaceId }) {
  const filter = withWorkspace({ flow: flowId }, workspaceId);
  const skip = (page - 1) * limit;
  const [enrollments, total] = await Promise.all([
    FlowEnrollment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('customer', 'firstname lastname phone')
      .populate('order', 'total')
      .populate('booking'),
    FlowEnrollment.countDocuments(filter),
  ]);

  // Resolves which button (if any) a customer tapped, for display alongside
  // the existing enrollment state — a light touch-up on the existing view,
  // not new analytics infrastructure (per-button click-through reporting is
  // an explicitly deferred §11 item, see the branching plan).
  const enrollmentIds = enrollments.map(e => e._id);
  const tapped = await CampaignMessage.find({
    flowEnrollment: { $in: enrollmentIds }, respondedAt: { $ne: null }, clickedButtonPosition: { $ne: null },
  }, 'flowEnrollment messageNode clickedButtonPosition').sort({ respondedAt: -1 });

  const nodeIds = [...new Set(tapped.map(t => t.messageNode?.toString()).filter(Boolean))];
  const nodes = nodeIds.length ? await MessageNode.find({ _id: { $in: nodeIds } }, 'buttons') : [];
  const nodeById = Object.fromEntries(nodes.map(n => [n._id.toString(), n]));

  const tappedLabelByEnrollment = {};
  for (const t of tapped) {
    const key = t.flowEnrollment?.toString();
    if (!key || tappedLabelByEnrollment[key]) continue; // most recent tap only (sorted desc above)
    const node = t.messageNode && nodeById[t.messageNode.toString()];
    const button = node?.buttons.find(b => b.position === t.clickedButtonPosition);
    tappedLabelByEnrollment[key] = button?.label || null;
  }

  const withTaps = enrollments.map(e => ({
    ...e.toObject(),
    tappedButtonLabel: tappedLabelByEnrollment[e._id.toString()] || null,
  }));

  return { enrollments: withTaps, total, page, pages: Math.ceil(total / limit) };
}

async function getFlowReport({ flowId, workspaceId }) {
  const flow = await Flow.findOne(scopedFilter(flowId, workspaceId));
  if (!flow) throw new Error('Flow not found');

  const [enrollmentCounts, messageAgg] = await Promise.all([
    FlowEnrollment.aggregate([
      { $match: { flow: flow._id } },
      { $group: { _id: '$state', count: { $sum: 1 } } },
    ]),
    CampaignMessage.aggregate([
      { $match: { flow: flow._id, kind: 'flow' } },
      { $group: {
        _id: null,
        sent:      { $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] } },
        read:      { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
        failed:    { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        // $gt (not $ne) against null — see getCampaignReport above for why.
        clicked:      { $sum: { $cond: [{ $gt: ['$clickedAt', null] }, 1, 0] } },
        ordered:      { $sum: { $cond: [{ $gt: ['$order', null] }, 1, 0] } },
        revenue:      { $sum: '$revenue' },
        pointsIssued: { $sum: '$pointsIssued' },
      } },
    ]),
  ]);

  const enrollmentMap = Object.fromEntries(enrollmentCounts.map(e => [e._id, e.count]));
  const m = messageAgg[0] || { sent: 0, delivered: 0, read: 0, failed: 0, clicked: 0, ordered: 0, revenue: 0, pointsIssued: 0 };
  const conversionRate = m.sent > 0 ? +((m.ordered / m.sent) * 100).toFixed(1) : 0;

  return {
    flowId: flow._id,
    name: flow.name,
    triggerType: flow.triggerType,
    status: flow.status,
    enrolled: enrollmentMap.enrolled || 0,
    messaged: enrollmentMap.messaged || 0,
    exited: enrollmentMap.exited || 0,
    completed: enrollmentMap.completed || 0,
    messagesSent: m.sent,
    messagesDelivered: m.delivered,
    messagesRead: m.read,
    messagesFailed: m.failed,
    clicked: m.clicked,
    ordersCreated: m.ordered,
    revenue: +m.revenue.toFixed(2),
    pointsIssued: m.pointsIssued,
    conversionRate,
  };
}

// ─── Message Nodes (branching — see models/MessageNode.js) ───────────────────
// v1 scope: ownerType is always 'flow'. A Flow's entryNodeId (optional) points
// at one of these; its buttons' nextAction can branch to further MessageNodes.

const MAX_BUTTONS = 3;
const MAX_LABEL_LENGTH = 20;     // follow-up messages are interactive reply buttons: WhatsApp's 20-character title limit
const ENTRY_LABEL_LENGTH = 25;   // an entry message is a template: the quick-reply text limit is 25
const MAX_REPLY_TEXT = 1000;
const MAX_BRANCH_DEPTH = 3;
// Button actions that record consent (see shared/promoConsentTap.js). Only on the first message of a promotion.
const CONSENT_ACTIONS = ['opt_in', 'opt_out', 'interested'];
const TEMPLATE_BODY_MAX = 1024;
const TEMPLATE_FOOTER = 'Reply STOP to unsubscribe'; // what utils/whatsapp.js#createTemplate adds by default
const TEMPLATE_LANGUAGE = 'en';
const SEND_REQUEST_MAX_CUSTOMERS = 2000;

// Variables available for a custom entry message, per triggerType — the fixed
// {{n}} slot each maps to matches the existing hardcoded flow bodies exactly
// (customerName is always {{1}} where present), so switching a flow between a
// custom and default template never reshuffles positional params.
const FLOW_MESSAGE_VARIABLES = {
  inactive_customer:       [{ key: 'customerName', label: 'Customer Name', slot: 1 }],
  post_purchase_points:    [{ key: 'customerName', label: 'Customer Name', slot: 1 }, { key: 'pointsBalance', label: 'Points Balance', slot: 2 }],
  points_balance_reminder: [{ key: 'customerName', label: 'Customer Name', slot: 1 }, { key: 'pointsBalance', label: 'Points Balance', slot: 2 }],
  booking_no_show:         [{ key: 'customerName', label: 'Customer Name', slot: 1 }, { key: 'serviceName', label: 'Service Name', slot: 2 }],
};

function getFlowMessageVariables({ triggerType }) {
  return FLOW_MESSAGE_VARIABLES[triggerType] || [];
}

// Same purpose as FLOW_MESSAGE_VARIABLES, for a Promotion's custom entry
// message (DEFECT-02). Promotions vary far more than Flow trigger types
// (products vs services, cash vs points) so this stays one fixed generic set
// rather than one list per combination — buildPromoEntryNodeParams below
// resolves the right real value into each slot regardless of promotion shape.
const PROMOTION_MESSAGE_VARIABLES = [
  { key: 'customerName',   label: 'Customer Name',       slot: 1 },
  { key: 'itemName',       label: 'Product/Service Name', slot: 2 },
  { key: 'priceOrPoints',  label: 'Price or Points Cost', slot: 3 },
  { key: 'promoName',      label: 'Promotion Name',       slot: 4 },
];

function getPromotionMessageVariables() {
  return PROMOTION_MESSAGE_VARIABLES;
}

// ─── Custom entry message: approval gate, consent requests, template versions ─
// A promotion's own message is a WhatsApp template that Meta has to approve. Until it is approved nothing is sent with it:
// the old silent fallback to the default message is gone (PROMO_ENTRY_FALLBACK=on brings it back for ordinary promotions,
// never for a consent request, which has no default message). Instead the message is submitted to Meta automatically, the
// merchant's intended send is remembered (Promotion.sendRequest) and the send is refused with a typed
// TEMPLATE_NOT_APPROVED error before any customer is touched. When Meta approves, shared/templateApproval.js raises the
// "you can now send the messages you intended" notice on those promotions.

function typedError(message, props) { return Object.assign(new Error(message), props); }
const isConsentRequest = (promotion) => !!promotion && promotion.purpose === 'consent_request';
const entryFallbackOn = () => require('../utils/envFlag').isOn('PROMO_ENTRY_FALLBACK', false);

// The WhatsApp Business Account the work in progress sends from (utils/waTenant.js), or null when it cannot be told.
async function currentSenderWabaId() {
  let waTenant = null;
  try { waTenant = require('../utils/waTenant'); } catch (_) { /* not available: the platform account below */ }
  if (waTenant) {
    try {
      const sender = await waTenant.resolveCurrent();
      return sender && sender.wabaId ? String(sender.wabaId) : null;
    } catch (_) { return null; } // e.g. the customer's own number is unusable: cannot tell, never guess the platform account
  }
  if (typeof getWabaId === 'function') {
    try { const id = await getWabaId(); if (id) return String(id); } catch (_) { /* unknown */ }
  }
  return null;
}

// The promotion's entry message, but only when it belongs to the promotion's own workspace: a message id pointing into another
// customer's workspace is treated as if it did not exist.
async function loadEntryNode(promotion) {
  if (!promotion || !promotion.entryNodeId) return null;
  const node = await MessageNode.findById(promotion.entryNodeId._id || promotion.entryNodeId);
  if (!node) return null;
  if (node.workspaceId && promotion.workspaceId && String(node.workspaceId) !== String(promotion.workspaceId)) return null;
  return node;
}

// Approved by Meta AND approved in the WhatsApp account that is sending now. A message submitted under another account (the
// customer moved to its own number) has to be submitted again: Meta's approval does not travel with the number. When the
// current account cannot be told, the stored approval is trusted (the send itself then fails closed if the number is unusable).
async function nodeApprovedForSender(node) {
  if (!node || node.templateStatus !== 'approved') return false;
  if (!node.templateWabaId) return true; // approved before accounts were recorded
  const current = await currentSenderWabaId();
  return !current || String(current) === String(node.templateWabaId);
}

// Same graceful-fallback pattern as utils/flowScheduler.js#processEnrollment:
// only an *approved* custom entry message is ever used (no separate "activate"
// gate exists for Promotions, per DEFECT-04A, so this re-checks approval on
// every send rather than once at some earlier activation step). Used as it always
// was by the flow scheduler; sendPromotion/sendTestMessage use resolveEntryNodeForSend, which refuses instead of falling back.
async function resolveApprovedEntryNode(promotion) {
  const node = await loadEntryNode(promotion);
  return (await nodeApprovedForSender(node)) ? node : null;
}

const hasOptInButton = (node) => (node.buttons || []).some(b => b.nextAction && b.nextAction.type === 'opt_in');

function consentRequestInvalid(message) {
  return typedError(message, { code: 'CONSENT_REQUEST_INVALID', status: 400 });
}

// What Meta (or our own pre-checks) said when a submission failed, as one sentence for the merchant.
function submitFailureReason(err) {
  if (!err) return 'unknown error';
  if (err.code === 'TEMPLATE_INVALID') return err.message;
  const e = err.response && err.response.data && err.response.data.error;
  return (e && (e.error_user_msg || e.message)) || err.message || 'unknown error';
}

function templateBlockMessage({ templateStatus, submittedNow, submitError, rejectedReason }) {
  if (submitError) return `Your message could not be sent to Facebook (Meta) for approval: ${submitError} Sending is paused. Fix the message and try again.`;
  if (submittedNow) return 'Your message has been sent to Facebook (Meta) for approval. Sending is paused until it is approved; you will be told here as soon as you can send.';
  if (templateStatus === 'rejected') return `${rejectedReason || 'Facebook (Meta) did not approve this message.'} Edit the message and send it for approval again.`;
  return 'This message is still being reviewed by Facebook (Meta). Sending is paused until it is approved.';
}

// Remember what the merchant meant to send, so that once the message is approved the screen can offer exactly that.
async function recordSendRequest(promotion, requested, userId) {
  try {
    const request = {
      customerIds: (requested || []).map(c => c._id).slice(0, SEND_REQUEST_MAX_CUSTOMERS),
      requestedAt: new Date(),
    };
    if (OBJECT_ID_RE.test(String(userId || ''))) request.requestedBy = String(userId);
    await Promotion.updateOne({ _id: promotion._id }, { $set: { sendRequest: request } });
  } catch (err) {
    console.error('[sendPromotion] could not record the send request:', err.message);
  }
}

// One live status check for a message that is waiting for Meta, or that Meta paused (it may have been approved / reactivated
// since the last sweep). Never throws: on any failure the stored status stands.
async function refreshPendingNode(node) {
  try { return await refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: node.workspaceId }); } catch (_) { return node; }
}

// The entry message to send with, or null for "no custom message: send the default". Throws instead of falling back:
//   CONSENT_REQUEST_INVALID (400)  a consent request with no message of its own or no "Opt in" button
//   TEMPLATE_NOT_APPROVED  (409)   the message is not approved (by Meta, or in the account that is sending): it is submitted
//                                  when it was never submitted, the intended send is recorded (not for a test send) and the
//                                  error carries { templateStatus, submittedNow }
async function resolveEntryNodeForSend({ promotion, requested, userId, forTest = false }) {
  const consent = isConsentRequest(promotion);
  const node = await loadEntryNode(promotion);
  if (!node) {
    if (consent) throw consentRequestInvalid('A consent request needs its own message with an "Opt in" button. Write the message and add the button before sending.');
    return null; // no custom message (or it is gone): the default promotion message, exactly as before
  }
  if (consent && !hasOptInButton(node)) throw consentRequestInvalid('This consent request has no "Opt in" button. Add one so customers can say yes.');
  if (await nodeApprovedForSender(node)) return node;
  if (!consent && entryFallbackOn()) return null; // kill switch PROMO_ENTRY_FALLBACK=on: the old silent fallback

  let current = node;
  if (current.templateStatus === 'pending' || current.templateStatus === 'rejected') {
    // approved a minute ago (or a paused message active again)? do not make the merchant wait for the next sweep
    current = await refreshPendingNode(current);
    if (await nodeApprovedForSender(current)) return current;
  }
  let submittedNow = false;
  let submitError = null;
  // 'approved' here means approved for another WhatsApp account: it has to be submitted again, like a message never submitted.
  if (current.templateStatus === 'not_created' || current.templateStatus === 'approved') {
    try {
      current = await submitMessageNodeTemplate({ nodeId: current._id, workspaceId: promotion.workspaceId });
      submittedNow = current.templateStatus === 'pending';
    } catch (err) {
      if (err && err.code === 'WHATSAPP_NUMBER_UNAVAILABLE') throw err; // the number itself is the problem: say so as it is
      submitError = submitFailureReason(err);
    }
  }
  if (!forTest) await recordSendRequest(promotion, requested, userId);
  const templateStatus = submitError ? 'not_created' : current.templateStatus;
  throw typedError(
    templateBlockMessage({ templateStatus, submittedNow, submitError, rejectedReason: current.templateRejectedReason }),
    { code: 'TEMPLATE_NOT_APPROVED', status: 409, templateStatus, submittedNow, ...(submitError ? { reason: submitError } : {}) },
  );
}

// A customer whose own WhatsApp number cannot be used right now (invalid token, unreadable token...) gets ONE clear refusal
// (WHATSAPP_NUMBER_UNAVAILABLE, HTTP 409) before a send loop starts, instead of a loop in which every message fails. Anything
// else surfaces where the send itself happens.
async function requireUsableSender() {
  try {
    await require('../utils/waTenant').resolveCurrent({ waba: false });
  } catch (err) {
    if (err && err.code === 'WHATSAPP_NUMBER_UNAVAILABLE') throw err;
  }
}

// A consent request goes to the customers who have NOT opted in: never an opted-out (or erased) one, never one who already
// said yes, never one asked within CONSENT_ASK_COOLDOWN_DAYS (default 7; 0 = no cooldown). Demo data is exempt, as for any
// promotion (nothing real is ever sent to it).
function consentAskCooldownDays() {
  const raw = process.env.CONSENT_ASK_COOLDOWN_DAYS;
  const n = (raw === undefined || String(raw).trim() === '') ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

// Even with CONSENT_ASK_COOLDOWN_DAYS=0 a person asked within the last minute is not asked again: two requests running at the same
// moment (a double click on Send, two staff members) must not both ask the same customer.
const CONSENT_ASK_CLAIM_GUARD_MS = 60 * 1000;

// Claim one customer for a consent request: stamp marketingConsentAskedAt only if they are STILL someone a consent request may
// reach (not opted out, not opted in, not asked within the cooldown). Atomic (one conditional update), so a second request running
// at the same moment loses the claim. Returns { at, previous } to give back on a failed send, or null when somebody else asked
// first / the person changed their mind meanwhile. A claim that cannot be made because the database failed is a skip, never a send.
// Won or lost is read from the document the database hands back (findOneAndUpdate, the way every other claim in this app is made),
// not from an updated-count that some database engines do not report faithfully.
async function claimConsentAsk(customer, workspaceId) {
  const guardMs = Math.max(consentAskCooldownDays() * 86400000, CONSENT_ASK_CLAIM_GUARD_MS);
  const at = new Date();
  try {
    const before = await Customer.findOneAndUpdate(
      withWorkspace({
        _id: customer._id, optedOut: { $ne: true }, marketingConsent: { $ne: true }, deletedAt: { $exists: false },
        $or: [{ marketingConsentAskedAt: { $exists: false } }, { marketingConsentAskedAt: null }, { marketingConsentAskedAt: { $lt: new Date(at.getTime() - guardMs) } }],
      }, workspaceId),
      { $set: { marketingConsentAskedAt: at } },
      { returnDocument: 'before' },
    );
    return before ? { at, previous: before.marketingConsentAskedAt || null } : null;
  } catch (err) {
    console.error('[sendPromotion] could not claim customer for the consent request (skipped):', err.message);
    return null;
  }
}

// Undo claimConsentAsk after a send that did not go out (only if nobody asked in between).
async function releaseConsentAsk(customer, workspaceId, claim) {
  const update = claim.previous ? { $set: { marketingConsentAskedAt: claim.previous } } : { $unset: { marketingConsentAskedAt: 1 } };
  await Customer.updateOne(withWorkspace({ _id: customer._id, marketingConsentAskedAt: claim.at }, workspaceId), update).catch(() => {});
}

function splitConsentRequestAudience(requested, promotion, now = Date.now()) {
  const cooldownMs = consentAskCooldownDays() * 86400000;
  const out = { eligible: [], skippedOptedOut: 0, skippedAlreadyOptedIn: 0, skippedAskedRecently: 0 };
  for (const c of requested) {
    if ((promotion && promotion.isDemo) || c.isDemo) { out.eligible.push(c); continue; }
    if (c.optedOut || c.deletedAt) out.skippedOptedOut++;
    else if (c.marketingConsent === true) out.skippedAlreadyOptedIn++;
    else if (cooldownMs > 0 && c.marketingConsentAskedAt && now - new Date(c.marketingConsentAskedAt).getTime() < cooldownMs) out.skippedAskedRecently++;
    else out.eligible.push(c);
  }
  return out;
}

// The tap payload of each entry button, in button order (the template's quick-reply index). A consent action carries
// everything the tap handler needs in the payload itself - promo:<promotionId>:<action>:<position> - so editing the message
// later can never change what an old tap meant. Every other button keeps msgnode_<nodeId>_<position>. A test send uses the
// inert promotest: prefix for the consent actions: nothing listens for it, so a test tap can never write consent.
function buildEntryButtonPayloads(entryNode, promotion, { test = false } = {}) {
  return entryNode.buttons.map((b) => {
    const action = b.nextAction && b.nextAction.type;
    if (CONSENT_ACTIONS.includes(action)) return `${test ? 'promotest' : 'promo'}:${promotion._id}:${action}:${b.position}`;
    return `msgnode_${entryNode._id}_${b.position}`;
  });
}

function placeholderCount(text) {
  const numbers = [...String(text || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => +m[1]);
  return numbers.length ? Math.max(...numbers) : 0;
}

// The values for the body's {{n}} slots: exactly as many as the SUBMITTED text has (Meta refuses a different number: "number of
// parameters does not match"). The message of a promotion may use one to four of the four available values, so a message written
// with fewer slots than four must not be sent with four (it used to be, and every recipient failed).
async function entryNodeParams(customer, promotion, items, node) {
  const params = await buildPromoEntryNodeParams(customer, promotion, items);
  const submitted = (node.templateSnapshot && node.templateSnapshot.bodyText) || node.bodyText;
  return params.slice(0, placeholderCount(submitted));
}

// What this customer was shown, copied onto the CampaignMessage of a consent request: the text of the version Meta approved
// (not whatever the merchant has typed since), rendered with this customer's values, with the footer and every button.
function buildConsentSnapshot({ promotion, node, params, payloads }) {
  const snap = node.templateSnapshot && node.templateSnapshot.bodyText ? node.templateSnapshot : null;
  const bodyTemplate = snap ? snap.bodyText : node.bodyText;
  let renderedBody = bodyTemplate;
  params.forEach((val, i) => { renderedBody = renderedBody.split(`{{${i + 1}}}`).join(String(val)); });
  const shown = snap && snap.buttons && snap.buttons.length ? snap.buttons : node.buttons;
  const buttons = [...shown].sort((a, b) => a.position - b.position).map((b) => {
    const i = node.buttons.findIndex(x => x.position === b.position);
    const live = i >= 0 ? node.buttons[i] : null;
    return {
      position: b.position,
      label: b.label,
      action: (live && live.nextAction && live.nextAction.type) || b.action || 'end_flow',
      payload: i >= 0 ? payloads[i] : undefined,
    };
  });
  return {
    promotionName: promotion.name,
    purpose: 'consent_request',
    templateName: node.templateName,
    ...(node.templateVersion != null ? { templateVersion: node.templateVersion } : {}),
    language: (snap && snap.language) || TEMPLATE_LANGUAGE,
    bodyTemplate,
    renderedBody,
    footer: (snap && snap.footer) || TEMPLATE_FOOTER,
    buttons,
  };
}

// Resolves PROMOTION_MESSAGE_VARIABLES' 4 slots to real values for one send —
// mirrors how FLOW_MESSAGE_VARIABLES' slots are filled in flowTriggers/*'s buildSend.
async function buildPromoEntryNodeParams(customer, promotion, items) {
  const isPoints = promotion.customerType === 'points';
  const item = items[0];
  const currency = await getCurrency();
  const priceOrPoints = isPoints
    ? `${promotion.pointsPrice || 0} pts`
    : money(item ? +(item.basePrice * (1 - (promotion.discountPercent || 0) / 100)).toFixed(2) : 0, currency);
  return [
    customer.firstname || 'Valued Customer',
    item?.name || 'our latest offer',
    priceOrPoints,
    promotion.name,
  ];
}

// The first message of a promotion is a template (button text up to 25 characters); every follow-up is an interactive
// message (up to 20). The consent actions (Opt in / Opt out / Interested) exist only on the first message of a promotion:
// that is the only place the consent-recording tap payload is used.
function validateButtons(buttons, { isEntryNode = false, ownerType } = {}) {
  if (!Array.isArray(buttons)) return;
  if (buttons.length > MAX_BUTTONS) throw new Error(`A message can have at most ${MAX_BUTTONS} buttons.`);
  const maxLabel = isEntryNode ? ENTRY_LABEL_LENGTH : MAX_LABEL_LENGTH;
  for (const b of buttons) {
    if (b.label && b.label.length > maxLabel) {
      throw new Error(`Button label "${b.label}" exceeds ${maxLabel} characters.`);
    }
    const action = b.nextAction && b.nextAction.type;
    if (CONSENT_ACTIONS.includes(action) && !(isEntryNode && ownerType === 'promotion')) {
      throw new Error('The "Opt in", "Opt out" and "Interested" button actions can only be used on the first message of a promotion.');
    }
    const replyText = b.nextAction && b.nextAction.replyText;
    if (replyText != null && String(replyText).length > MAX_REPLY_TEXT) {
      throw new Error(`The reply to a button can be at most ${MAX_REPLY_TEXT} characters.`);
    }
  }
}

// Did the part of the message Meta reviewed (the text, or the number/labels of the buttons) change? What a button DOES
// (its action, its reply) is not part of the template.
function sameButtonLabels(before, after) {
  const labels = (list) => [...(list || [])].sort((a, b) => a.position - b.position).map(b => b.label);
  const a = labels(before);
  const b = labels(after);
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

// The frontend only ever creates *new* target nodes via "+ Create new
// message," never relinks a button to an already-existing node — so the
// graph is structurally a tree with no cycle risk, as long as this is
// enforced server-side too (an MCP/GPT caller isn't bound by the frontend's
// own discipline). excludeNodeId lets a node keep its own pre-existing,
// unchanged link to a position without false-flagging itself.
async function assertTreeOnly(ownerId, excludeNodeId, buttons) {
  const targeted = (buttons || [])
    .filter(b => b.nextAction?.type === 'send_message' && b.nextAction.targetNodeId)
    .map(b => ({ position: b.position, targetNodeId: b.nextAction.targetNodeId.toString() }));
  if (!targeted.length) return;

  const allNodes = await MessageNode.find({ ownerId });
  for (const { position, targetNodeId } of targeted) {
    for (const n of allNodes) {
      for (const b of n.buttons) {
        if (b.nextAction?.targetNodeId?.toString() !== targetNodeId) continue;
        const isSelf = excludeNodeId && n._id.toString() === excludeNodeId.toString() && b.position === position;
        if (!isSelf) throw new Error('That message is already linked from another button — each follow-up can only be reached from one place.');
      }
    }
  }
}

// Recursively removes a node and everything reachable through its
// send_message buttons — used both for a direct delete and for cleaning up
// whatever a button used to point at once it's retargeted or removed (that
// old subtree becomes unreachable garbage otherwise, since the tree-only
// constraint above guarantees nothing else could reference it).
// With a workspaceId the walk stays inside that customer's own messages: a button that points at another customer's message
// (it should never be possible to save one) is neither followed nor deleted.
async function deleteMessageNodeSubtree(nodeId, workspaceId) {
  const node = workspaceId ? await MessageNode.findOne(scopedFilter(nodeId, workspaceId)) : await MessageNode.findById(nodeId);
  if (!node) return;
  for (const b of node.buttons) {
    if (b.nextAction?.type === 'send_message' && b.nextAction.targetNodeId) {
      await deleteMessageNodeSubtree(b.nextAction.targetNodeId, workspaceId);
    }
  }
  if (workspaceId) await MessageNode.deleteOne(scopedFilter(nodeId, workspaceId));
  else await MessageNode.findByIdAndDelete(nodeId);
}

async function createMessageNode({ ownerType = 'flow', ownerId, isEntryNode = false, bodyText, buttons = [], depth = 0, workspaceId }) {
  if (depth > MAX_BRANCH_DEPTH || depth < 0) throw new Error(`Messages can only branch ${MAX_BRANCH_DEPTH} levels deep.`);
  validateButtons(buttons, { isEntryNode, ownerType });
  await assertOwned(ownerType === 'promotion' ? Promotion : Flow, ownerId, workspaceId, ownerType === 'promotion' ? 'That promotion' : 'That flow');
  await assertOwned(MessageNode, buttonTargets(buttons), workspaceId, 'A follow-up message');
  await assertTreeOnly(ownerId, undefined, buttons);
  return MessageNode.create({ ownerType, ownerId, isEntryNode, bodyText, buttons, depth, workspaceId });
}

// The ids of the follow-up messages a list of buttons points at.
function buttonTargets(buttons) {
  return (Array.isArray(buttons) ? buttons : []).map(b => b && b.nextAction && b.nextAction.targetNodeId).filter(Boolean);
}

async function updateMessageNode({ id, bodyText, buttons, workspaceId }) {
  const existing = await MessageNode.findOne(scopedFilter(id, workspaceId));
  if (!existing) throw new Error('MessageNode not found');

  const data = {};
  const unset = {};
  if (bodyText != null) data.bodyText = bodyText;
  if (buttons != null) {
    validateButtons(buttons, { isEntryNode: existing.isEntryNode, ownerType: existing.ownerType });
    await assertOwned(MessageNode, buttonTargets(buttons), workspaceId, 'A follow-up message');
    await assertTreeOnly(existing.ownerId, id, buttons);

    // Cascade-delete any button's previous target that this update no longer
    // references — orphaned the moment it's retargeted or removed, since the
    // tree-only constraint means nothing else could have pointed to it.
    const newTargetIds = new Set(
      buttons.filter(b => b.nextAction?.type === 'send_message' && b.nextAction.targetNodeId)
        .map(b => b.nextAction.targetNodeId.toString()),
    );
    for (const oldButton of existing.buttons) {
      const oldTarget = oldButton.nextAction?.targetNodeId;
      if (oldTarget && !newTargetIds.has(oldTarget.toString())) {
        await deleteMessageNodeSubtree(oldTarget, workspaceId);
      }
    }

    data.buttons = buttons;
  }
  // The template Meta approved holds the OLD words. Once the text, or the number or labels of the buttons, change, that
  // approval no longer describes the message: it goes back to "needs submitting" (the name is kept: the next submission is
  // the next version of it). Changing only what a button does (its action or its reply) is not part of the template.
  if (existing.isEntryNode && existing.templateName && existing.templateStatus && existing.templateStatus !== 'not_created') {
    const bodyChanged = data.bodyText !== undefined && data.bodyText !== existing.bodyText;
    const buttonsChanged = data.buttons !== undefined && !sameButtonLabels(existing.buttons, data.buttons);
    if (bodyChanged || buttonsChanged) {
      data.templateStatus = 'not_created';
      unset.templateApprovedAt = 1;
      unset.templateRejectedReason = 1;
    }
  }
  const update = Object.keys(unset).length ? { ...data, $unset: unset } : data;
  const node = await MessageNode.findOneAndUpdate(scopedFilter(id, workspaceId), update, { new: true, runValidators: true });
  if (!node) throw new Error('MessageNode not found');
  return node;
}

async function getMessageNode({ id, workspaceId }) {
  const node = await MessageNode.findOne(scopedFilter(id, workspaceId));
  if (!node) throw new Error('MessageNode not found');
  return node;
}

async function deleteMessageNode({ id, workspaceId }) {
  if (workspaceId) {
    const node = await MessageNode.findOne(scopedFilter(id, workspaceId));
    if (!node) throw new Error('MessageNode not found');
  }
  await deleteMessageNodeSubtree(id, workspaceId);
  return { success: true };
}

// Everything Meta would refuse about this message, found before anything is sent to it (and before a template slot is used),
// as plain sentences. Empty array = fine. `promotion` (optional) adds the rules of a consent request.
function validateTemplateSubmission(node, { promotion } = {}) {
  const reasons = [];
  const body = String(node.bodyText || '');
  const trimmed = body.trim();
  if (!trimmed) reasons.push('The message text is empty.');
  if (body.length > TEMPLATE_BODY_MAX) reasons.push(`The message is too long (${body.length} characters; the limit is ${TEMPLATE_BODY_MAX}).`);
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed)) reasons.push('The message cannot start with a variable such as {{1}}. Start with a few words, for example "Hi {{1}}".');
  if (/\{\{\s*\d+\s*\}\}$/.test(trimmed)) reasons.push('The message cannot end with a variable such as {{1}}. Finish with a few words or a full stop.');
  const tokens = [...trimmed.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1]);
  if (tokens.some(t => !/^\d+$/.test(t))) {
    reasons.push('Variables must be numbered like {{1}}, {{2}}.');
  } else if (tokens.length) {
    const numbers = [...new Set(tokens.map(Number))].sort((a, b) => a - b);
    if (numbers[0] !== 1 || numbers[numbers.length - 1] !== numbers.length) reasons.push('Variables must be numbered in order starting at {{1}}, with none left out.');
    else if (node.ownerType === 'promotion' && numbers.length > PROMOTION_MESSAGE_VARIABLES.length) reasons.push(`A promotion message can use the variables {{1}} to {{${PROMOTION_MESSAGE_VARIABLES.length}}} only.`);
  }
  const buttons = node.buttons || [];
  if (buttons.length > MAX_BUTTONS) reasons.push(`A message can have at most ${MAX_BUTTONS} buttons.`);
  const seen = new Set();
  for (const b of buttons) {
    const label = String(b.label || '').trim();
    if (!label) reasons.push('A button has no text.');
    else if (label.length > ENTRY_LABEL_LENGTH) reasons.push(`Button "${label}" is too long (${label.length} characters; the limit is ${ENTRY_LABEL_LENGTH}).`);
    if (label && seen.has(label.toLowerCase())) reasons.push(`Two buttons are both called "${label}". Give each button its own text.`);
    seen.add(label.toLowerCase());
  }
  if (isConsentRequest(promotion) && !hasOptInButton(node)) reasons.push('A consent request needs an "Opt in" button so customers can say yes.');
  return reasons;
}

// What is being submitted to Meta, as stored on the node: the words the customer will see (and what each button does).
function buildTemplateSnapshot(node) {
  return {
    bodyText: node.bodyText,
    footer: TEMPLATE_FOOTER,
    language: TEMPLATE_LANGUAGE,
    buttons: [...node.buttons].sort((a, b) => a.position - b.position).map(b => ({
      position: b.position,
      label: b.label,
      action: (b.nextAction && b.nextAction.type) || 'end_flow',
      ...(b.nextAction && b.nextAction.replyText ? { replyText: b.nextAction.replyText } : {}),
    })),
  };
}

// Version n of a message's template: the first submission is waflow_flow_<last 10 of the node id>, every later one (after an
// edit, a rejection, or a move to another WhatsApp account) the same name + _v<n>. Names are lowercase letters, digits and
// underscores only (Meta's rule), derived from the node id so no two messages ever share one. An old version is never
// deleted (it keeps its slot on Meta; deleting only frees the name after a delay).
function nextTemplateVersion(node) {
  return node.templateName ? (Number(node.templateVersion) || 1) + 1 : 1;
}
function templateNameFor(node, version) {
  const base = `waflow_flow_${String(node._id).slice(-10)}`;
  return version === 1 ? base : `${base}_v${version}`;
}

// Two concurrent submissions of one message (two sends pressed at once) would each mint a version: the second caller
// shares the first one's work instead.
const submissionsInFlight = new Map();

// Dynamically builds and submits a Meta template creation request from a
// merchant-authored entry node's current bodyText/buttons — the same
// createTemplate() call the 4 fixed flow templates already go through, just
// parameterized instead of hardcoded. Only entry nodes need a template; every
// other node sends free-form (see utils/whatsapp.js#sendMessageNodeFollowUp).
// Fails with a TEMPLATE_INVALID (400, `reasons`) error when Meta would refuse the message, before anything is sent.
async function submitMessageNodeTemplate({ nodeId, workspaceId }) {
  const key = `${workspaceId || ''}:${nodeId}`;
  if (submissionsInFlight.has(key)) return submissionsInFlight.get(key);
  const work = doSubmitMessageNodeTemplate({ nodeId, workspaceId }).finally(() => submissionsInFlight.delete(key));
  submissionsInFlight.set(key, work);
  return work;
}

async function doSubmitMessageNodeTemplate({ nodeId, workspaceId }) {
  const node = await MessageNode.findOne(scopedFilter(nodeId, workspaceId));
  if (!node) throw new Error('MessageNode not found');
  if (!node.isEntryNode) throw new Error('Only entry nodes need a template.');

  let promotion = null;
  if (node.ownerType === 'promotion') {
    try { promotion = await Promotion.findById(node.ownerId, 'purpose workspaceId').lean(); } catch (_) { promotion = null; }
  }
  const reasons = validateTemplateSubmission(node, { promotion });
  if (reasons.length) throw typedError(reasons.join(' '), { status: 400, code: 'TEMPLATE_INVALID', reasons });

  const snapshot = buildTemplateSnapshot(node);
  // Already waiting for Meta with exactly these words: nothing to send again (a second copy would only use up another slot).
  if (node.templateStatus === 'pending' && node.templateSnapshot && node.templateSnapshot.bodyText === snapshot.bodyText
    && sameButtonLabels(node.templateSnapshot.buttons, snapshot.buttons)) {
    return node;
  }

  // DEFECT-06: resubmitting after an edit can't reuse the same template name — Meta treats it as already taken
  // (pending/approved) or still mid-deletion (rejected templates that got cleaned up, see DEFECT-05), either way a second
  // POST under the same name fails. Every resubmission therefore mints the next version's name and leaves the superseded
  // template on Meta as harmless history.
  const version = nextTemplateVersion(node);
  const templateName = templateNameFor(node, version);

  await createTemplate(templateName, node.bodyText, 'MARKETING', node.buttons.map(b => b.label), { footer: snapshot.footer, language: snapshot.language });
  const wabaId = await currentSenderWabaId();

  node.templateName = templateName;
  node.templateStatus = 'pending';
  node.templateVersion = version;
  node.templateSubmittedAt = new Date();
  node.templateWabaId = wabaId || undefined; // the account it was submitted to: approval does not travel to another one
  node.templateCategory = 'MARKETING';
  node.templateSnapshot = snapshot;
  node.templateApprovedAt = undefined;
  node.templateRejectedReason = undefined;
  node.templateLastCheckedAt = undefined;
  await node.save();
  return node;
}

// Why Meta did not approve (or stopped allowing) a message, as one sentence for the merchant.
function rejectionText(template) {
  const status = String(template.status || '').toUpperCase();
  if (status === 'PAUSED') return 'Facebook (Meta) has paused this message because customers reacted badly to it. Edit it, or try again later.';
  if (status === 'DISABLED') return 'Facebook (Meta) has disabled this message.';
  const code = String(template.rejected_reason || '').trim();
  return code && code.toUpperCase() !== 'NONE' ? `Facebook (Meta) did not approve this message (${code}).` : 'Facebook (Meta) did not approve this message.';
}

// A message just became approved: tell shared/templateApproval.js so the promotions waiting on it raise their "you can now
// send" notice. Never throws (the status itself is already saved).
async function notifyTemplateApproved(node) {
  try {
    const approval = require('./templateApproval');
    if (approval && typeof approval.markApprovedNotice === 'function') await approval.markApprovedNotice(node);
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') console.error('[templates] approval notice failed:', err.message);
  }
}

// Meta reviews a submitted template asynchronously — nothing pushes that
// outcome back to us, so this pulls the current live status on demand (same
// on-demand-fetch pattern Settings already uses for the 4 fixed flow
// templates; shared/templateApproval.js also does it on a timer) and syncs it onto the node. The template is looked up BY
// NAME (utils/whatsapp.js#getTemplate), so a busy shared WhatsApp account cannot hide it.
// minAgeMs (optional): a check made less than this long ago is still the answer. The screen polls while a message is waiting for
// approval, and every check reads the WhatsApp account's template list, which Meta rate-limits per account (shared by every customer
// on the platform number); the sweeper, the send gate and Meta's own status news always ask for a fresh read (no minAgeMs).
async function refreshMessageNodeTemplateStatus({ nodeId, workspaceId, minAgeMs = 0 }) {
  const node = await MessageNode.findOne(scopedFilter(nodeId, workspaceId));
  if (!node) throw new Error('MessageNode not found');
  if (!node.templateName) return node; // never submitted yet
  // Edited since it was submitted: the name still belongs to the OLD version, whose status says nothing about this text.
  if (node.templateStatus === 'not_created') return node;
  if (minAgeMs > 0 && node.templateLastCheckedAt && Date.now() - new Date(node.templateLastCheckedAt).getTime() < minAgeMs) return node;

  const template = await getTemplate(node.templateName);
  if (template) {
    const statusMap = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'rejected', DISABLED: 'rejected' };
    const before = node.templateStatus;
    node.templateStatus = statusMap[String(template.status || '').toUpperCase()] || node.templateStatus;
    node.templateLastCheckedAt = new Date();
    if (template.category) node.templateCategory = template.category;
    node.templateRejectedReason = node.templateStatus === 'rejected' ? rejectionText(template) : undefined;
    if (node.templateStatus === 'approved' && before !== 'approved') node.templateApprovedAt = new Date();
    await node.save();
    if (before !== 'approved' && node.templateStatus === 'approved') await notifyTemplateApproved(node);
  } else if (node.templateStatus === 'pending' || node.templateStatus === 'rejected') {
    // Meta does not list this name in the WhatsApp account being read. Either the message was submitted to ANOTHER account (the
    // customer got a number of its own meanwhile) or it was deleted at Meta / never arrived: waiting longer cannot help, so it goes
    // back to "not sent for approval" and the next Send submits it again as a new version. (A message submitted a moment ago may not
    // be listed yet: only one that has had ten minutes is given up on.)
    const current = await currentSenderWabaId().catch(() => null);
    const otherAccount = !!(node.templateWabaId && current && String(node.templateWabaId) !== String(current));
    const submittedAt = node.templateSubmittedAt ? new Date(node.templateSubmittedAt).getTime() : 0;
    if (otherAccount || (submittedAt && Date.now() - submittedAt > 10 * 60 * 1000)) {
      node.templateStatus = 'not_created';
      node.templateRejectedReason = undefined;
      node.templateLastCheckedAt = new Date();
      await node.save();
    }
  }
  return node;
}

module.exports = {
  listProducts, getProduct, createProduct, updateProduct, deactivateProduct,
  listServices, getService, createService, updateService, deactivateService,
  createTimeSlot, listBookings, cancelBooking, rescheduleBooking, completeBooking,
  confirmBooking, declineBooking, markNoShow,
  listCustomers, getCustomer, createCustomer, updateCustomer, getCustomerWhatsAppHistory, getConsentStats, sendConsentRequests, markCustomerConsented,
  listOrders, getOrder, updateOrderStatus, refundOrder, getOrderStats, createOrder, getPaymentStatus,
  listPromotions, getPromotion, createPromotion, updatePromotion, deletePromotion,
  getRecommendedCustomers, sendPromotion, sendLoyaltyReminders, getCampaignReport,
  previewPromotionMessage, sendTestMessage, getPromotionMessageVariables,
  resolveApprovedEntryNode, buildPromoEntryNodeParams, entryNodeParams, resolvePromoItems,
  getLoyaltySettings, updateLoyaltySettings,
  listFlows, getFlow, createFlow, updateFlow, activateFlow, pauseFlow, deleteFlow,
  listFlowEnrollments, getFlowReport, previewFlowMessage, getFlowPresets,
  createMessageNode, updateMessageNode, getMessageNode, deleteMessageNode,
  submitMessageNodeTemplate, refreshMessageNodeTemplateStatus, getFlowMessageVariables,
  getCustomerReturnRate, getTopLoyaltyCustomers, getBestPerformingPromotion, listInactiveCustomers,
  scopedFilter, withWorkspace, workspaceMatch, stripeWorkspaceMeta,
  // consent requests / template approval gate (see "Custom entry message" above)
  dismissSendRequest, buildEntryButtonPayloads, resolveEntryNodeForSend, splitConsentRequestAudience, consentAskCooldownDays,
  validateTemplateSubmission, buildTemplateSnapshot, nextTemplateVersion, templateNameFor, validateButtons,
  buildConsentSnapshot, buildConsentReport, consentRate, consentLogRow, getConsentLog, getConsentLogCsv, getCustomerConsentEvents, csvSafe,
};
