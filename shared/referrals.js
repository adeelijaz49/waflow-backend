// Referral Promotions engine — a complete, standalone feature (see
// Referral_Promotions_Requirements.md). Reads the existing Customer/Order/
// Booking/Workspace models and uses the existing requireAuth/consent/
// WhatsApp-send plumbing, but owns its own 6 new collections and never
// mutates anything outside them. Nothing here is wired into existing
// checkout/booking code paths (createOrder, confirmBooking, the Stripe
// webhook) — those are existing files this pass doesn't touch. Instead,
// qualifying actions that depend on an order/booking are detected by
// reconcilePendingReferrals, a periodic sweep (see startReferralScheduler)
// that reads Order/Booking the same way any reporting query would, so a
// reward lands within one sweep interval of the real event rather than
// instantly. Actions this module *can* see directly (link clicked, WhatsApp
// started, customer created) are handled in real time.
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');

const ReferralPromotion = require('../models/ReferralPromotion');
const ReferralCode      = require('../models/ReferralCode');
const ReferralClick     = require('../models/ReferralClick');
const Referral           = require('../models/Referral');
const ReferralReward     = require('../models/ReferralReward');
const Voucher            = require('../models/Voucher');
const Customer           = require('../models/Customer');
const Order              = require('../models/Order');
const Booking            = require('../models/Booking');
const SchedulerLock      = require('../models/SchedulerLock');

const { waPost } = require('../utils/whatsapp');
const tokenManager = require('../utils/tokenManager');
const { APP_URL } = require('../utils/config');
const { canSendMarketing } = require('./consent');

const WA_PHONE_ID = process.env.WA_PHONE_ID || '1032683093271618';
const WA_BASE = 'https://graph.facebook.com/v25.0';

// ─── Small helpers ────────────────────────────────────────────────────────────

function withWorkspace(filter, workspaceId) {
  if (workspaceId) filter.workspaceId = workspaceId;
  return filter;
}
function scopedFilter(id, workspaceId) {
  return withWorkspace({ _id: id }, workspaceId);
}

// customerIds arrives as a raw JSON array from request bodies (not a route
// param, which Express always decodes as a plain string) — Mongoose's query
// casting lets a field value like {"$ne": null} through as a legitimate
// operator rather than rejecting it, so every id must be checked to actually
// be an id *before* it reaches any filter. Same risk class as an
// unvalidated countryCode/category reaching a rate-card query.
function assertValidCustomerIds(customerIds) {
  if (!Array.isArray(customerIds) || !customerIds.length) throw new Error('customerIds must be a non-empty array');
  for (const id of customerIds) {
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) throw new Error(`Invalid customer id: ${JSON.stringify(id)}`);
  }
  return customerIds;
}

// 10 uppercase hex chars — random, not guessable, carries no customer data.
// Used both as the URL slug (/r/<code>) and as the "Code: <code>" token
// embedded in the WhatsApp deep-link message for inbound detection.
function generateCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function hashValue(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function buildShortUrl(code, type) {
  return `${APP_URL}/${type === 'generic' ? 'c' : 'r'}/${code}`;
}

function customerName(c) {
  return `${c?.firstname || ''} ${c?.lastname || ''}`.trim() || c?.phone || '';
}

// Resolves the merchant's actual WhatsApp phone number (the digits wa.me
// needs), not the Graph API's internal phone-number-id. Cached in-process
// for the life of the server — mirrors utils/whatsapp.js#getWabaId's own
// cache-first pattern, kept here rather than added to that file.
let cachedWaNumber = null;
async function getMerchantWaNumber() {
  if (cachedWaNumber) return cachedWaNumber;
  try {
    const res = await axios.get(`${WA_BASE}/${WA_PHONE_ID}`, {
      params: { fields: 'display_phone_number' },
      headers: { Authorization: `Bearer ${tokenManager.getToken()}` },
    });
    cachedWaNumber = (res.data?.display_phone_number || '').replace(/[^\d]/g, '');
  } catch (err) {
    console.error('[referrals] could not resolve merchant WhatsApp number:', err.message);
  }
  return cachedWaNumber || (process.env.WA_DISPLAY_NUMBER || '').replace(/[^\d]/g, '');
}

function buildWaMeLink(number, message) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

// ─── Referral promotion CRUD ──────────────────────────────────────────────────

async function createReferralPromotion(data) {
  return ReferralPromotion.create(data);
}

async function listReferralPromotions({ workspaceId, status } = {}) {
  const filter = withWorkspace({}, workspaceId);
  if (status) filter.status = status;
  return ReferralPromotion.find(filter).sort({ createdAt: -1 }).lean();
}

async function getReferralPromotion({ id, workspaceId }) {
  const promo = await ReferralPromotion.findOne(scopedFilter(id, workspaceId)).lean();
  if (!promo) throw new Error('Referral promotion not found');
  return promo;
}

async function updateReferralPromotion({ id, workspaceId, ...data }) {
  delete data.workspaceId; delete data._id;
  const promo = await ReferralPromotion.findOneAndUpdate(scopedFilter(id, workspaceId), data, { new: true, runValidators: true });
  if (!promo) throw new Error('Referral promotion not found');
  return promo;
}

const PROMOTION_STATUSES = ['draft', 'active', 'paused', 'ended'];
async function setReferralPromotionStatus({ id, workspaceId, status }) {
  if (!PROMOTION_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
  const promo = await ReferralPromotion.findOneAndUpdate(scopedFilter(id, workspaceId), { status }, { new: true, runValidators: true });
  if (!promo) throw new Error('Referral promotion not found');
  return promo;
}

// ─── Link / QR generation ──────────────────────────────────────────────────────

// The one referrer-less link for a promotion (social posts, QR on a flyer).
// Idempotent — returns the existing one if already generated.
async function getOrCreateGenericCode({ referralPromotionId, workspaceId }) {
  const promo = await getReferralPromotion({ id: referralPromotionId, workspaceId });
  let code = await ReferralCode.findOne(withWorkspace({ referralPromotionId, referrerCustomerId: { $exists: false } }, workspaceId));
  if (code) return code;

  const value = generateCode();
  code = await ReferralCode.create({
    workspaceId: promo.workspaceId, referralPromotionId, code: value,
    shortUrl: buildShortUrl(value, 'generic'),
  });
  return code;
}

// One link per referrer per promotion. Idempotent per customer.
async function getOrCreateCustomerCode({ referralPromotionId, customerId, workspaceId }) {
  let code = await ReferralCode.findOne(withWorkspace({ referralPromotionId, referrerCustomerId: customerId }, workspaceId));
  if (code) return code;

  const promo = await getReferralPromotion({ id: referralPromotionId, workspaceId });
  const value = generateCode();
  try {
    code = await ReferralCode.create({
      workspaceId: promo.workspaceId, referralPromotionId, referrerCustomerId: customerId,
      code: value, shortUrl: buildShortUrl(value, 'referrer'),
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    code = await ReferralCode.findOne(withWorkspace({ referralPromotionId, referrerCustomerId: customerId }, workspaceId));
  }
  return code;
}

async function generateCustomerCodes({ referralPromotionId, customerIds, workspaceId }) {
  assertValidCustomerIds(customerIds);
  const codes = [];
  for (const customerId of customerIds) {
    codes.push(await getOrCreateCustomerCode({ referralPromotionId, customerId, workspaceId }));
  }
  return codes;
}

// Lazily generated + cached on the ReferralCode doc — qrcode's PNG data URL
// output is small enough to store inline, avoiding a file-storage dependency.
async function getQrCodeDataUrl({ referralCodeId, workspaceId }) {
  const code = await ReferralCode.findOne(scopedFilter(referralCodeId, workspaceId));
  if (!code) throw new Error('Referral link not found');
  if (code.qrCodeDataUrl) return code.qrCodeDataUrl;

  const QRCode = require('qrcode');
  const dataUrl = await QRCode.toDataURL(code.shortUrl, { margin: 1, width: 400 });
  code.qrCodeDataUrl = dataUrl;
  await code.save();
  return dataUrl;
}

// ─── Sending links to customers ────────────────────────────────────────────────

function referralMessage(customer, promotion, code) {
  const friendBit = promotion.friendRewardLabel
    || (promotion.friendRewardType === 'percent_discount' ? `${promotion.friendRewardValue}% off their first order`
      : promotion.friendRewardType === 'fixed_discount' ? `${promotion.friendRewardValue} off their first order`
      : promotion.friendRewardType === 'loyalty_points' ? `${promotion.friendRewardValue} bonus points`
      : 'a special offer');
  const referrerBit = promotion.referrerRewardLabel
    || (promotion.referrerRewardType === 'loyalty_points' ? `${promotion.referrerRewardValue} points`
      : promotion.referrerRewardType === 'percent_discount' ? `${promotion.referrerRewardValue}% off`
      : promotion.referrerRewardType === 'fixed_discount' ? `${promotion.referrerRewardValue} off`
      : 'a reward');
  return `Hi ${customer.firstname || ''}👋 Share this link with a friend. They'll get ${friendBit}, and you'll earn ${referrerBit} when they buy: ${code.shortUrl}`.replace(/\s+/g, ' ').trim();
}

// Sends each selected customer their own link as a manual WhatsApp text —
// skips (never sends to) opted-out/non-consented customers, matching the
// requirement that promotional referral messages respect opt-out status.
async function sendReferralLinksToCustomers({ referralPromotionId, customerIds, workspaceId }) {
  assertValidCustomerIds(customerIds);
  const promotion = await getReferralPromotion({ id: referralPromotionId, workspaceId });
  const customers = await Customer.find(withWorkspace({ _id: { $in: customerIds } }, workspaceId));

  let sentCount = 0;
  const skipped = [];
  for (const customer of customers) {
    if (!canSendMarketing(customer) && !customer.isDemo) { skipped.push({ customerId: customer._id, reason: 'not_consented_or_opted_out' }); continue; }
    const code = await getOrCreateCustomerCode({ referralPromotionId, customerId: customer._id, workspaceId });
    const body = referralMessage(customer, promotion, code);
    try {
      await waPost({ messaging_product: 'whatsapp', to: customer.phone, type: 'text', text: { body } });
      sentCount++;
    } catch (err) {
      skipped.push({ customerId: customer._id, reason: err.message });
    }
  }
  return { sentCount, skipped, total: customers.length };
}

// ─── Click tracking + redirect ─────────────────────────────────────────────────

// Called by the public, unauthenticated /r/:code and /c/:code routes. Never
// throws for a bad/expired code — returns null so the route can show a
// plain "link not found" page instead of a stack trace.
async function recordClickAndGetRedirect({ code, source, medium, ip, userAgent }) {
  const referralCode = await ReferralCode.findOne({ code });
  if (!referralCode || referralCode.status !== 'active') return null;

  const promotion = await ReferralPromotion.findById(referralCode.referralPromotionId).lean();
  if (!promotion || promotion.status === 'ended') return null;
  if (promotion.endsAt && promotion.endsAt < new Date()) return null;

  await ReferralClick.create({
    workspaceId: referralCode.workspaceId, referralPromotionId: referralCode.referralPromotionId,
    referralCodeId: referralCode._id, referrerCustomerId: referralCode.referrerCustomerId,
    source, medium, ipHash: hashValue(ip), userAgentHash: hashValue(userAgent),
  });
  await ReferralCode.findByIdAndUpdate(referralCode._id, { $inc: { clickCount: 1 } });

  // One Referral document per (code, "this click session") — a customer-
  // specific code reuses the same Referral across repeat clicks until it's
  // attributed to a real friend; a generic code gets a fresh Referral per
  // click since there's no referrer to de-duplicate against yet.
  let referral;
  if (referralCode.referrerCustomerId) {
    referral = await Referral.findOneAndUpdate(
      { referralCodeId: referralCode._id, referredCustomerId: { $exists: false }, status: { $in: ['link_created', 'clicked'] } },
      { $setOnInsert: {
          workspaceId: referralCode.workspaceId, referralPromotionId: referralCode.referralPromotionId,
          referralCodeId: referralCode._id, referrerCustomerId: referralCode.referrerCustomerId,
          attributionSource: 'click', firstClickAt: new Date(),
        },
        $set: { status: 'clicked' },
      },
      { upsert: true, new: true },
    );
  } else {
    referral = await Referral.create({
      workspaceId: referralCode.workspaceId, referralPromotionId: referralCode.referralPromotionId,
      referralCodeId: referralCode._id, status: 'clicked', firstClickAt: new Date(), attributionSource: 'click',
    });
  }

  const number = await getMerchantWaNumber();
  const message = `Hi, I'd like to claim my referral offer. Code: ${referralCode.code}`;
  const waLink = number ? buildWaMeLink(number, message) : null;

  return { referral, promotion, referralCode, waLink };
}

// ─── Inbound WhatsApp referral-code detection ──────────────────────────────────

const CODE_PATTERN = /code:\s*([A-F0-9]{10})/i;

function extractReferralCode(message) {
  const text = message?.text?.body || message?.button?.text || '';
  const match = text.match(CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

// Called from server.js's WhatsApp webhook handler, right alongside the
// Inbox feature's logInboundMessage — a no-op (returns immediately) for the
// overwhelming majority of inbound messages, which never carry a referral
// code. When one does: auto-creates/updates the friend's Customer profile
// (same pattern as shared/inbox.js), attributes the Referral, applies
// self-referral / already-a-customer abuse checks, and issues the friend's
// reward immediately (the referrer's reward waits for the qualifying
// action — see reconcilePendingReferrals).
async function handleInboundReferralCode({ workspaceId, from, message, contactName }) {
  if (!workspaceId || !from || !message) return;
  const code = extractReferralCode(message);
  if (!code) return;

  const referralCode = await ReferralCode.findOne({ code, workspaceId });
  if (!referralCode || referralCode.status !== 'active') return;
  const promotion = await ReferralPromotion.findById(referralCode.referralPromotionId);
  if (!promotion) return;

  // Self-referral guard — compare phones, the one identity we always have.
  if (referralCode.referrerCustomerId) {
    const referrer = await Customer.findById(referralCode.referrerCustomerId).lean();
    if (referrer && referrer.phone === from) {
      await Referral.findOneAndUpdate(
        { referralCodeId: referralCode._id, referrerCustomerId: referralCode.referrerCustomerId },
        { status: 'voided', rejectionReason: 'self_referral' },
        { sort: { createdAt: -1 } },
      );
      return;
    }
  }

  const existedBefore = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
  let friend = existedBefore;
  if (!friend) {
    const [firstname, ...rest] = (contactName || from).trim().split(/\s+/);
    friend = await Customer.create({ workspaceId, phone: from, firstname: firstname || from, lastname: rest.join(' ') });
  }

  // "A phone number already known to the merchant should not count as a new
  // customer unless merchant allows it" — MVP default is to block the
  // reward outright rather than expose a merchant-facing override yet.
  if (existedBefore) {
    await Referral.findOneAndUpdate(
      { referralCodeId: referralCode._id, referrerCustomerId: referralCode.referrerCustomerId || { $exists: false }, referredCustomerId: { $exists: false } },
      { status: 'rejected', rejectionReason: 'phone_already_known', referredCustomerId: friend._id, whatsappStartedAt: new Date() },
      { sort: { createdAt: -1 } },
    );
    return;
  }

  // Attach to the most recent not-yet-attributed Referral for this code
  // (created at click time for a customer-specific link), or create a fresh
  // one outright for a generic link where there's no prior click to attach to.
  let referral = await Referral.findOneAndUpdate(
    { referralCodeId: referralCode._id, referredCustomerId: { $exists: false } },
    { $set: {
        referredCustomerId: friend._id, referredPhoneHash: hashValue(from),
        status: 'customer_created', whatsappStartedAt: new Date(), customerCreatedAt: new Date(),
        attributionSource: 'whatsapp_code',
      },
      $setOnInsert: {
        workspaceId: referralCode.workspaceId, referralPromotionId: referralCode.referralPromotionId,
        referralCodeId: referralCode._id, referrerCustomerId: referralCode.referrerCustomerId,
      },
    },
    { sort: { createdAt: -1 }, upsert: true, new: true },
  ).catch(async (err) => {
    if (err.code !== 11000) throw err; // already rewarded for this promotion — treat as a harmless repeat message
    return null;
  });
  if (!referral) return;

  await issueFriendReward({ referral, promotion, friend });

  // Three qualifying actions are already fully known at this exact moment —
  // check immediately rather than waiting for the next sweep.
  if (['whatsapp_started', 'customer_created'].includes(promotion.qualifyingAction) || promotion.qualifyingAction === 'link_clicked') {
    await maybeQualifyAndReward(referral, promotion);
  }
}

// ─── Rewards ──────────────────────────────────────────────────────────────────

async function createVoucherFor({ workspaceId, customerId, type, value, label, referralId, expiresAt }) {
  return Voucher.create({
    workspaceId, customerId, type, value, label, sourceReferralId: referralId,
    code: generateCode(), expiresAt,
  });
}

// The friend's reward is granted as soon as they're attributed (not gated
// behind a qualifying action — they were promised it for simply using the link).
async function issueFriendReward({ referral, promotion, friend }) {
  if (promotion.friendRewardType === 'none') return;
  if (promotion.friendRewardType === 'loyalty_points') {
    await Customer.findByIdAndUpdate(friend._id, { $inc: { loyaltyPoints: promotion.friendRewardValue || 0 }, $set: { loyaltyPointsUpdatedAt: new Date() } });
    return;
  }
  const typeMap = { fixed_discount: 'fixed_discount', percent_discount: 'percent_discount', voucher: 'fixed_discount', free_item: 'free_item' };
  const voucherType = typeMap[promotion.friendRewardType];
  if (!voucherType) return;
  await createVoucherFor({
    workspaceId: referral.workspaceId, customerId: friend._id, type: voucherType,
    value: promotion.friendRewardValue || 0, label: promotion.friendRewardLabel,
    referralId: referral._id, expiresAt: promotion.endsAt,
  });
}

async function countIssuedRewards({ referralPromotionId, referrerCustomerId }) {
  const [perReferrer, total] = await Promise.all([
    referrerCustomerId ? ReferralReward.countDocuments({ referralPromotionId, referrerCustomerId, status: 'issued' }) : 0,
    ReferralReward.countDocuments({ referralPromotionId, status: 'issued' }),
  ]);
  return { perReferrer, total };
}

// Grants (or queues for approval) the referrer's reward. Caps are enforced
// here, not just at the UI — a referral that would exceed either cap is
// rejected rather than silently skipped, so it's visible in reporting.
async function issueReferrerReward(referral, promotion) {
  if (!referral.referrerCustomerId || promotion.referrerRewardType === 'none') {
    referral.status = 'qualified'; referral.qualifiedAt = referral.qualifiedAt || new Date();
    await referral.save();
    return;
  }

  const { perReferrer, total } = await countIssuedRewards({ referralPromotionId: promotion._id, referrerCustomerId: referral.referrerCustomerId });
  if ((promotion.maxRewardsPerReferrer && perReferrer >= promotion.maxRewardsPerReferrer) || (promotion.maxTotalRewards && total >= promotion.maxTotalRewards)) {
    referral.status = 'rejected'; referral.rejectionReason = 'reward_cap_reached';
    await referral.save();
    return;
  }

  referral.status = 'qualified';
  referral.qualifiedAt = referral.qualifiedAt || new Date();
  referral.rewardType = promotion.referrerRewardType;
  referral.rewardValue = promotion.referrerRewardValue;

  if (promotion.requiresManualApproval || promotion.referrerRewardType === 'manual') {
    referral.status = 'reward_pending'; referral.rewardStatus = 'pending_approval';
    await referral.save();
    await ReferralReward.create({
      workspaceId: referral.workspaceId, referralId: referral._id, referrerCustomerId: referral.referrerCustomerId,
      referredCustomerId: referral.referredCustomerId, rewardType: promotion.referrerRewardType,
      rewardValue: promotion.referrerRewardValue, status: 'pending_approval',
    });
    return;
  }

  await applyReferrerReward(referral, promotion);
}

async function applyReferrerReward(referral, promotion) {
  let voucherId;
  if (promotion.referrerRewardType === 'loyalty_points') {
    await Customer.findByIdAndUpdate(referral.referrerCustomerId, { $inc: { loyaltyPoints: promotion.referrerRewardValue || 0 }, $set: { loyaltyPointsUpdatedAt: new Date() } });
  } else if (['fixed_discount', 'percent_discount', 'voucher', 'free_item'].includes(promotion.referrerRewardType)) {
    const typeMap = { fixed_discount: 'fixed_discount', percent_discount: 'percent_discount', voucher: 'fixed_discount', free_item: 'free_item' };
    const voucher = await createVoucherFor({
      workspaceId: referral.workspaceId, customerId: referral.referrerCustomerId, type: typeMap[promotion.referrerRewardType],
      value: promotion.referrerRewardValue || 0, label: promotion.referrerRewardLabel, referralId: referral._id,
    });
    voucherId = voucher._id;
  }

  referral.status = 'reward_issued';
  referral.rewardStatus = 'issued';
  referral.rewardIssuedAt = new Date();
  await referral.save();

  await ReferralReward.create({
    workspaceId: referral.workspaceId, referralId: referral._id, referrerCustomerId: referral.referrerCustomerId,
    referredCustomerId: referral.referredCustomerId, rewardType: promotion.referrerRewardType,
    rewardValue: promotion.referrerRewardValue, voucherId, status: 'issued', issuedAt: new Date(),
  });
}

// "loyalty_joined" has no dedicated opt-in flag in this app's data model —
// every Customer record already implies loyalty-programme membership, so
// it's treated as equivalent to customer_created.
async function evaluateQualification(referral, promotion) {
  switch (promotion.qualifyingAction) {
    case 'link_clicked': return !!referral.firstClickAt;
    case 'whatsapp_started': return !!referral.whatsappStartedAt;
    case 'customer_created':
    case 'loyalty_joined': return !!referral.customerCreatedAt;
    case 'first_order':
    case 'payment_completed':
    case 'minimum_spend': {
      if (!referral.referredCustomerId) return false;
      const orders = await Order.find({ customer: referral.referredCustomerId, workspaceId: promotion.workspaceId, status: { $ne: 'cancelled' } }).lean();
      if (!orders.length) return false;
      if (promotion.qualifyingAction === 'payment_completed') return orders.some(o => o.paymentStatus === 'paid');
      if (promotion.qualifyingAction === 'minimum_spend') return orders.reduce((s, o) => s + (o.total || 0), 0) >= (promotion.minimumSpend || 0);
      return { match: orders[0] };
    }
    case 'first_booking': {
      if (!referral.referredCustomerId) return false;
      const booking = await Booking.findOne({ customerId: referral.referredCustomerId, workspaceId: promotion.workspaceId, status: { $in: ['confirmed', 'completed'] } }).lean();
      return booking ? { match: booking, isBooking: true } : false;
    }
    default: return false;
  }
}

async function maybeQualifyAndReward(referral, promotion) {
  if (['qualified', 'reward_pending', 'reward_issued', 'rejected', 'expired', 'voided'].includes(referral.status)) return;
  const result = await evaluateQualification(referral, promotion);
  if (!result) return;

  if (result?.match) {
    if (result.isBooking) { referral.bookingId = result.match._id; }
    else { referral.orderId = result.match._id; referral.revenueAmount = result.match.total || 0; }
  }
  await issueReferrerReward(referral, promotion);
}

// ─── Periodic reconciliation (covers order/booking-based qualifying actions) ──

async function reconcilePendingReferrals(workspaceId) {
  const filter = withWorkspace({ status: { $in: ['clicked', 'whatsapp_started', 'customer_created'] }, referredCustomerId: { $exists: true } }, workspaceId);
  const referrals = await Referral.find(filter).limit(500);
  const promoCache = new Map();

  for (const referral of referrals) {
    try {
      const key = String(referral.referralPromotionId);
      let promotion = promoCache.get(key);
      if (!promotion) {
        promotion = await ReferralPromotion.findById(referral.referralPromotionId).lean();
        promoCache.set(key, promotion);
      }
      if (!promotion || promotion.status === 'ended') continue;
      await maybeQualifyAndReward(referral, promotion);
    } catch (err) {
      console.error(`[referrals] reconcile error (referral ${referral._id}):`, err.message);
    }
  }
  return { checked: referrals.length };
}

const RECONCILE_INTERVAL_MS = +(process.env.REFERRAL_RECONCILE_INTERVAL_MS || 5 * 60 * 1000);
const LOCK_ID = 'referralReconciliation';
let schedulerHandle = null;

async function acquireLock() {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + RECONCILE_INTERVAL_MS - 60000);
  const renewed = await SchedulerLock.findOneAndUpdate(
    { _id: LOCK_ID, lockedUntil: { $lt: now } }, { $set: { lockedAt: now, lockedUntil } }, { new: true },
  );
  if (renewed) return true;
  try { await SchedulerLock.create({ _id: LOCK_ID, lockedAt: now, lockedUntil }); return true; }
  catch (err) { if (err.code === 11000) return false; throw err; }
}

function startReferralScheduler() {
  if (schedulerHandle) return; // idempotent
  const tick = () => acquireLock().then(ok => ok && reconcilePendingReferrals()).catch(err => console.error('[referrals] scheduler tick error:', err.message));
  tick();
  schedulerHandle = setInterval(tick, RECONCILE_INTERVAL_MS);
}

// ─── Reporting / admin actions ─────────────────────────────────────────────────

async function getReferralReport({ referralPromotionId, workspaceId }) {
  const promotion = await getReferralPromotion({ id: referralPromotionId, workspaceId }); // throws if this promotion isn't this workspace's
  const [linksGenerated, clicks, referrals] = await Promise.all([
    ReferralCode.countDocuments(withWorkspace({ referralPromotionId }, workspaceId)),
    ReferralClick.countDocuments(withWorkspace({ referralPromotionId }, workspaceId)),
    Referral.find(withWorkspace({ referralPromotionId }, workspaceId)).lean(),
  ]);
  // ReferralReward doesn't carry referralPromotionId directly — fetch via its Referral.
  const rewards = await ReferralReward.find({ referralId: { $in: referrals.map(r => r._id) } }).lean();

  const whatsappStarted = referrals.filter(r => r.whatsappStartedAt).length;
  const newCustomers = referrals.filter(r => r.customerCreatedAt).length;
  const converted = referrals.filter(r => r.orderId || r.bookingId);
  const revenue = converted.reduce((s, r) => s + (r.revenueAmount || 0), 0);
  const rewardedReferrals = referrals.filter(r => r.status === 'reward_issued');
  const pointsIssued = rewards.filter(r => r.rewardType === 'loyalty_points' && r.status === 'issued').reduce((s, r) => s + (r.rewardValue || 0), 0);
  // Referrer vouchers go through ReferralReward; friend vouchers are created
  // directly (issueFriendReward has no approval step, so no reward record) —
  // count both via Voucher.sourceReferralId so this reflects everyone who
  // actually got a voucher, not just the referrer side.
  const vouchersIssued = await Voucher.countDocuments({ sourceReferralId: { $in: referrals.map(r => r._id) }, status: { $ne: 'voided' } });

  const byReferrer = new Map();
  for (const r of referrals) {
    if (!r.referrerCustomerId) continue;
    const key = String(r.referrerCustomerId);
    const entry = byReferrer.get(key) || { referrerCustomerId: r.referrerCustomerId, successfulReferrals: 0 };
    if (r.status === 'reward_issued' || r.status === 'qualified') entry.successfulReferrals++;
    byReferrer.set(key, entry);
  }
  const topReferrerEntries = [...byReferrer.values()].sort((a, b) => b.successfulReferrals - a.successfulReferrals).slice(0, 10);
  const topReferrerCustomers = await Customer.find({ _id: { $in: topReferrerEntries.map(e => e.referrerCustomerId) } }).lean();
  const nameById = Object.fromEntries(topReferrerCustomers.map(c => [String(c._id), customerName(c)]));
  const topReferrers = topReferrerEntries.map(e => ({ ...e, name: nameById[String(e.referrerCustomerId)] || 'Unknown' }));

  return {
    promotion, linksGenerated, linksShared: linksGenerated, clicks,
    whatsappStarted, newCustomers, conversions: converted.length, revenue,
    referrersRewarded: rewardedReferrals.length, pointsIssued, vouchersIssued,
    conversionRate: clicks > 0 ? +((converted.length / clicks) * 100).toFixed(1) : 0,
    topReferrers,
    referrals,
  };
}

async function getCustomerReferralSummary({ customerId, workspaceId }) {
  const [asReferrer, asReferred, rewards] = await Promise.all([
    Referral.find(withWorkspace({ referrerCustomerId: customerId }, workspaceId)).sort({ createdAt: -1 }).lean(),
    Referral.findOne(withWorkspace({ referredCustomerId: customerId }, workspaceId)).lean(),
    ReferralReward.find({ referrerCustomerId: customerId, status: 'issued' }).lean(),
  ]);
  return {
    referralLinksShared: asReferrer.length,
    successfulReferrals: asReferrer.filter(r => ['qualified', 'reward_pending', 'reward_issued'].includes(r.status)).length,
    rewardsEarned: rewards.length,
    referrals: asReferrer,
    referredBy: asReferred,
  };
}

async function voidReferral({ id, workspaceId, reason }) {
  const referral = await Referral.findOneAndUpdate(scopedFilter(id, workspaceId), { status: 'voided', rejectionReason: reason || 'Voided by merchant' }, { new: true });
  if (!referral) throw new Error('Referral not found');
  return referral;
}

async function approveReferralReward({ referralId, workspaceId, approve, userId }) {
  const referral = await Referral.findOne(scopedFilter(referralId, workspaceId));
  if (!referral) throw new Error('Referral not found');
  if (referral.status !== 'reward_pending') throw new Error('This referral is not awaiting approval');

  const promotion = await ReferralPromotion.findById(referral.referralPromotionId).lean();
  const pendingReward = await ReferralReward.findOne({ referralId: referral._id, status: 'pending_approval' });

  if (!approve) {
    referral.status = 'rejected'; referral.rejectionReason = 'Rejected by merchant'; referral.rewardStatus = 'rejected';
    await referral.save();
    if (pendingReward) { pendingReward.status = 'rejected'; await pendingReward.save(); }
    return referral;
  }

  if (pendingReward) await ReferralReward.findByIdAndUpdate(pendingReward._id, { status: 'voided' }); // superseded by the real issuance below
  if (promotion.referrerRewardType === 'manual') {
    referral.status = 'reward_issued'; referral.rewardStatus = 'issued'; referral.rewardIssuedAt = new Date();
    await referral.save();
    await ReferralReward.create({
      workspaceId: referral.workspaceId, referralId: referral._id, referrerCustomerId: referral.referrerCustomerId,
      referredCustomerId: referral.referredCustomerId, rewardType: promotion.referrerRewardType,
      rewardValue: promotion.referrerRewardValue, status: 'issued', issuedAt: new Date(), approvedByUserId: userId,
    });
  } else {
    await applyReferrerReward(referral, promotion);
  }
  return referral;
}

async function listPendingRewardApprovals({ workspaceId }) {
  return Referral.find(withWorkspace({ status: 'reward_pending' }, workspaceId)).sort({ createdAt: -1 }).lean();
}

async function redeemVoucher({ id, workspaceId, userId }) {
  const voucher = await Voucher.findOneAndUpdate(
    withWorkspace({ _id: id, status: 'active' }, workspaceId),
    { status: 'redeemed', redeemedAt: new Date(), redeemedByUserId: userId },
    { new: true },
  );
  if (!voucher) throw new Error('Voucher not found or already used');
  return voucher;
}

module.exports = {
  createReferralPromotion, listReferralPromotions, getReferralPromotion, updateReferralPromotion, setReferralPromotionStatus,
  getOrCreateGenericCode, getOrCreateCustomerCode, generateCustomerCodes, getQrCodeDataUrl,
  sendReferralLinksToCustomers,
  recordClickAndGetRedirect,
  handleInboundReferralCode,
  reconcilePendingReferrals, startReferralScheduler,
  getReferralReport, getCustomerReferralSummary,
  voidReferral, approveReferralReward, listPendingRewardApprovals, redeemVoucher,
};
