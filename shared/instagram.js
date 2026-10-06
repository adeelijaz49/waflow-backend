// Instagram Promotion Scheduler engine — a complete, standalone feature (see
// Instagram_Promotion_Scheduler_Requirements.md). Reads existing Customer/
// Order/Booking/Workspace models and reuses existing WhatsApp-send/upload/AI
// plumbing, but owns its own 6 new collections. Nothing here deletes any
// document — cancel/disconnect are status changes, never removals (see
// memory: a prior cleanup script's regex once deleted a real customer).
//
// No real Meta Developer App is registered for Instagram in this
// environment (only the existing, separate WhatsApp Business API app) — the
// OAuth connect flow and the real publish calls cannot be live-tested here.
// Every other part of this engine (scheduling, retries, tracking/
// attribution, AI content, reporting, entitlement gating) is fully built and
// testable independently of a real Instagram connection — see the feature
// summary for exactly what was and wasn't verified live.
const crypto = require('crypto');

const SocialAccount      = require('../models/SocialAccount');
const InstagramPost      = require('../models/InstagramPost');
const SocialPublishJob   = require('../models/SocialPublishJob');
const TrackingLink       = require('../models/TrackingLink');
const TrackingEvent      = require('../models/TrackingEvent');
const InstagramEntitlement = require('../models/InstagramEntitlement');
const Customer  = require('../models/Customer');
const Order     = require('../models/Order');
const Booking   = require('../models/Booking');
const SchedulerLock = require('../models/SchedulerLock');

const tokenCrypto = require('./socialTokenCrypto');
const igApi = require('./instagramApi');
const igAi  = require('./instagramAi');
const tokenManager = require('../utils/tokenManager');
const axios = require('axios');
const { APP_URL } = require('../utils/config');

const WA_PHONE_ID = process.env.WA_PHONE_ID || '1032683093271618';
const WA_BASE = 'https://graph.facebook.com/v25.0';

function withWorkspace(filter, workspaceId) {
  if (workspaceId) filter.workspaceId = workspaceId;
  return filter;
}
function scopedFilter(id, workspaceId) {
  return withWorkspace({ _id: id }, workspaceId);
}
function customerName(c) {
  return `${c?.firstname || ''} ${c?.lastname || ''}`.trim() || c?.phone || '';
}

// ─── Entitlement (standalone flag — see models/InstagramEntitlement.js) ──────

async function getOrCreateEntitlement(workspaceId) {
  let ent = await InstagramEntitlement.findOne({ workspaceId });
  if (ent) return ent;
  try {
    ent = await InstagramEntitlement.create({ workspaceId });
  } catch (err) {
    if (err.code !== 11000) throw err;
    ent = await InstagramEntitlement.findOne({ workspaceId });
  }
  return ent;
}

async function isInstagramEnabled(workspaceId) {
  const ent = await getOrCreateEntitlement(workspaceId);
  return ent.enabled;
}

async function setEntitlement({ workspaceId, enabled, grantedBy, notes }) {
  const ent = await getOrCreateEntitlement(workspaceId);
  ent.enabled = !!enabled;
  if (enabled) { ent.grantedAt = new Date(); ent.grantedBy = grantedBy; }
  if (notes !== undefined) ent.notes = notes;
  await ent.save();
  return ent;
}

function assertEnabled(entitlement) {
  if (!entitlement.enabled) {
    const err = new Error('Instagram Promotion Scheduler is not enabled for this workspace — contact WaFlow to enable this add-on.');
    err.code = 'INSTAGRAM_NOT_ENABLED';
    throw err;
  }
}

// ─── Social account connect/disconnect ───────────────────────────────────────

async function getSocialAccountStatus(workspaceId) {
  const account = await SocialAccount.findOne(withWorkspace({ provider: 'instagram' }, workspaceId)).lean();
  if (!account) return { status: 'not_connected', configured: igApi.isConfigured() };
  return {
    status: account.status, accountName: account.accountName, accountHandle: account.accountHandle,
    tokenExpiresAt: account.tokenExpiresAt, configured: igApi.isConfigured(), lastError: account.lastError,
  };
}

// Signs workspaceId into the OAuth `state` param (HMAC, not just base64) so
// the callback can trust which workspace initiated the connection without
// needing a server-side session — the callback arrives on Meta's redirect,
// outside any logged-in request context.
function signState(workspaceId) {
  const secret = process.env.AUTH_JWT_SECRET || 'dev-only-fallback';
  const payload = `${workspaceId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function verifyState(state) {
  const secret = process.env.AUTH_JWT_SECRET || 'dev-only-fallback';
  const decoded = Buffer.from(state, 'base64url').toString('utf8');
  const [workspaceId, ts, sig] = decoded.split('.');
  const expected = crypto.createHmac('sha256', secret).update(`${workspaceId}.${ts}`).digest('hex');
  if (sig !== expected) throw new Error('Invalid or tampered OAuth state');
  if (Date.now() - Number(ts) > 15 * 60 * 1000) throw new Error('OAuth state expired — please try connecting again');
  return workspaceId;
}

function getAuthorizeUrl(workspaceId) {
  return igApi.getAuthorizeUrl(signState(workspaceId));
}

async function handleOAuthCallback({ code, state }) {
  const workspaceId = verifyState(state);
  const shortLived = await igApi.exchangeCodeForToken(code);
  const longLived = await igApi.exchangeForLongLivedToken(shortLived.access_token);
  const info = await igApi.getAccountInfo(longLived.access_token);

  const tokenExpiresAt = new Date(Date.now() + (longLived.expires_in || 5184000) * 1000);
  const update = {
    $set: {
      workspaceId, provider: 'instagram', providerAccountId: info.id,
      accountName: info.username, accountHandle: `@${info.username}`,
      accessTokenEncrypted: tokenCrypto.encrypt(longLived.access_token),
      scopes: (shortLived.permissions || '').split(',').filter(Boolean),
      tokenExpiresAt, status: 'connected',
    },
    // A stale lastError from a previous failed connection must not survive
    // a successful reconnect (undefined in a plain update object is dropped
    // by Mongoose rather than clearing the field — see disconnectAccount).
    $unset: { lastError: '' },
  };
  const account = await SocialAccount.findOneAndUpdate(
    { workspaceId, provider: 'instagram' }, update, { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return account;
}

// Status-only change — never deletes the SocialAccount document, so
// historical posts' socialAccountId reference stays valid.
async function disconnectAccount(workspaceId) {
  // Mongoose drops `undefined` values from an update object entirely (it's
  // not the same as setting null/$unset), so clearing the token must go
  // through $unset explicitly or the encrypted token silently survives
  // "disconnect" in the database.
  const account = await SocialAccount.findOneAndUpdate(
    withWorkspace({ provider: 'instagram' }, workspaceId),
    { $set: { status: 'not_connected' }, $unset: { accessTokenEncrypted: '', refreshTokenEncrypted: '' } },
    { new: true },
  );
  if (!account) throw new Error('No Instagram account connected');
  return account;
}

// ─── Posts CRUD ──────────────────────────────────────────────────────────────

const PROMO_CODE_PATTERN_SOURCE = '[A-Z0-9]{8}';
function generatePromotionCode() {
  return `IG-${crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8)}`;
}
function generateTrackingCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function createPost(data) {
  const entitlement = await getOrCreateEntitlement(data.workspaceId);
  assertEnabled(entitlement);

  const account = await SocialAccount.findOne(withWorkspace({ provider: 'instagram' }, data.workspaceId));
  if (!account) throw new Error('Connect an Instagram account before creating a promotion');

  const post = await InstagramPost.create({ ...data, socialAccountId: account._id, promotionCode: generatePromotionCode() });
  await createTrackingLinkForPost(post);
  return getPost({ id: post._id, workspaceId: post.workspaceId });
}

async function createTrackingLinkForPost(post) {
  const code = generateTrackingCode();
  const link = await TrackingLink.create({
    workspaceId: post.workspaceId, instagramPostId: post._id,
    content: post.name, code, shortUrl: `${APP_URL}/t/${code}`,
  });
  post.trackingLinkId = link._id;
  await post.save();
  return link;
}

async function listPosts({ workspaceId, status }) {
  const filter = withWorkspace({}, workspaceId);
  if (status) filter.status = status;
  return InstagramPost.find(filter).sort({ scheduledAt: -1, createdAt: -1 }).lean();
}

async function getPost({ id, workspaceId }) {
  const post = await InstagramPost.findOne(scopedFilter(id, workspaceId)).lean();
  if (!post) throw new Error('Instagram promotion not found');
  const trackingLink = post.trackingLinkId ? await TrackingLink.findById(post.trackingLinkId).lean() : null;
  return { ...post, trackingLink };
}

const EDITABLE_FIELDS = ['name', 'goal', 'productId', 'serviceId', 'offerDescription', 'startsAt', 'endsAt', 'postType', 'mediaUrl', 'thumbnailUrl', 'caption', 'hashtags', 'whatsappCtaText', 'destinationAction'];
async function updatePost({ id, workspaceId, ...data }) {
  const update = {};
  for (const key of EDITABLE_FIELDS) if (data[key] !== undefined) update[key] = data[key];
  const post = await InstagramPost.findOneAndUpdate({ ...scopedFilter(id, workspaceId), status: { $in: ['draft', 'scheduled', 'failed'] } }, update, { new: true, runValidators: true });
  if (!post) throw new Error('Instagram promotion not found, or it has already been published/cancelled');
  return post;
}

async function duplicatePost({ id, workspaceId }) {
  const original = await InstagramPost.findOne(scopedFilter(id, workspaceId)).lean();
  if (!original) throw new Error('Instagram promotion not found');
  const { _id, createdAt, updatedAt, status, scheduledAt, publishedAt, providerPostId, providerContainerId, errorCode, errorMessage, trackingLinkId, promotionCode, ...rest } = original;
  const copy = await InstagramPost.create({ ...rest, name: `${rest.name} (copy)`, status: 'draft', promotionCode: generatePromotionCode() });
  await createTrackingLinkForPost(copy);
  return getPost({ id: copy._id, workspaceId });
}

// Cancel is a status change only, never a delete — a cancelled post stays
// visible in the calendar/history with its full record intact.
async function cancelPost({ id, workspaceId }) {
  const post = await InstagramPost.findOneAndUpdate(
    { ...scopedFilter(id, workspaceId), status: { $in: ['draft', 'scheduled', 'failed'] } },
    { status: 'cancelled' }, { new: true },
  );
  if (!post) throw new Error('Instagram promotion not found, or it cannot be cancelled from its current status');
  await SocialPublishJob.updateMany({ instagramPostId: post._id, status: 'pending' }, { status: 'cancelled' });
  return post;
}

// ─── AI content generation (drafts only — never auto-published) ─────────────

async function generateContentForPost({ id, workspaceId, businessName }) {
  const post = await InstagramPost.findOne(scopedFilter(id, workspaceId)).lean();
  if (!post) throw new Error('Instagram promotion not found');
  return igAi.generateContent({ businessName, goal: post.goal, offerDescription: post.offerDescription, productOrServiceName: post.name });
}

async function refineContent({ currentCaption, instruction }) {
  if (!instruction?.trim()) throw new Error('instruction is required');
  return { caption: await igAi.refineContent({ currentCaption, instruction }) };
}

// ─── Scheduling limit safety ─────────────────────────────────────────────────

const MAX_PENDING_SCHEDULED_PER_ACCOUNT = 20;
async function checkSchedulingLimit(socialAccountId) {
  const count = await InstagramPost.countDocuments({ socialAccountId, status: 'scheduled' });
  return { count, limit: MAX_PENDING_SCHEDULED_PER_ACCOUNT, allowed: count < MAX_PENDING_SCHEDULED_PER_ACCOUNT };
}

async function schedulePost({ id, workspaceId, scheduledAt }) {
  const post = await InstagramPost.findOne({ ...scopedFilter(id, workspaceId), status: { $in: ['draft', 'failed'] } });
  if (!post) throw new Error('Instagram promotion not found, or it is not in a schedulable state');
  if (!post.mediaUrl) throw new Error('Upload media before scheduling this post');
  if (!scheduledAt || new Date(scheduledAt) <= new Date()) throw new Error('scheduledAt must be a future date/time');

  const { allowed, count, limit } = await checkSchedulingLimit(post.socialAccountId);
  if (!allowed) throw new Error(`This Instagram account already has ${count} scheduled posts (limit ${limit}) — publish or cancel one before scheduling another.`);

  post.status = 'scheduled';
  post.scheduledAt = new Date(scheduledAt);
  await post.save();
  await SocialPublishJob.create({ instagramPostId: post._id, workspaceId: post.workspaceId, scheduledAt: post.scheduledAt, status: 'pending' });
  return post;
}

// ─── Publishing (the real 2-step Meta flow) ──────────────────────────────────

const MAX_PUBLISH_ATTEMPTS = 3;
const CONTAINER_POLL_ATTEMPTS = 5;
const CONTAINER_POLL_DELAY_MS = 2000;

async function waitForContainerReady({ accessToken, containerId }) {
  for (let i = 0; i < CONTAINER_POLL_ATTEMPTS; i++) {
    const { status_code } = await igApi.getContainerStatus({ accessToken, containerId });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Media container ${status_code.toLowerCase()}`);
    await new Promise(r => setTimeout(r, CONTAINER_POLL_DELAY_MS));
  }
  throw new Error('Media container took too long to process');
}

// Publishes one post right now — used both by "Publish Now" and by the
// scheduler for a due post. Never throws past this point for an expected
// failure (missing connection, Meta API error) — always resolves the post
// to 'published' or 'failed' with a clear errorMessage, per the spec's
// failure-handling requirement.
async function publishPostNow(postId) {
  const post = await InstagramPost.findById(postId);
  if (!post) throw new Error('Instagram promotion not found');

  const fail = async (code, message) => {
    post.status = 'failed'; post.errorCode = code; post.errorMessage = message;
    await post.save();
    return post;
  };

  const entitlement = await getOrCreateEntitlement(post.workspaceId);
  if (!entitlement.enabled) return fail('INSTAGRAM_NOT_ENABLED', 'Instagram Promotion Scheduler is not enabled for this workspace.');

  const account = await SocialAccount.findById(post.socialAccountId);
  if (!account || account.status !== 'connected') return fail('ACCOUNT_NOT_CONNECTED', 'No connected Instagram account — reconnect in Settings.');
  if (account.tokenExpiresAt && account.tokenExpiresAt < new Date()) {
    account.status = 'token_expired'; await account.save();
    return fail('TOKEN_EXPIRED', 'Instagram connection token has expired — reconnect the account.');
  }
  if (!post.mediaUrl) return fail('MEDIA_MISSING', 'No media uploaded for this post.');

  let accessToken;
  try { accessToken = tokenCrypto.decrypt(account.accessTokenEncrypted); }
  catch (err) { return fail('TOKEN_DECRYPT_FAILED', err.message); }

  const fullCaption = [post.caption, post.whatsappCtaText, (post.hashtags || []).map(h => `#${h}`).join(' ')].filter(Boolean).join('\n\n');
  if (fullCaption.length > 2200) return fail('CAPTION_TOO_LONG', 'Caption (including CTA and hashtags) exceeds Instagram\'s 2,200 character limit.');

  post.status = 'publishing';
  await post.save();

  try {
    const container = await igApi.createMediaContainer({
      accessToken, igUserId: account.providerAccountId, caption: fullCaption,
      imageUrl: post.postType === 'image' ? post.mediaUrl : undefined,
      videoUrl: post.postType !== 'image' ? post.mediaUrl : undefined,
    });
    post.providerContainerId = container.id;
    await post.save();

    await waitForContainerReady({ accessToken, containerId: container.id });
    const published = await igApi.publishContainer({ accessToken, igUserId: account.providerAccountId, containerId: container.id });

    post.providerPostId = published.id;
    post.publishedAt = new Date();
    post.status = 'published';
    post.errorCode = undefined; post.errorMessage = undefined;
    await post.save();
    return post;
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    return fail(err.response?.data?.error?.code ? String(err.response.data.error.code) : 'META_API_ERROR', message);
  }
}

// ─── Scheduler (scheduled-post publishing + attribution reconciliation) ─────

async function processDueJob(job) {
  const claimed = await SocialPublishJob.findOneAndUpdate(
    { _id: job._id, status: 'pending' },
    { status: 'processing', lastAttemptAt: new Date(), $inc: { attempts: 1 } },
    { new: true },
  );
  if (!claimed) return; // another tick/instance already claimed it

  const post = await publishPostNow(claimed.instagramPostId);

  if (post.status === 'published') {
    claimed.status = 'success';
    await claimed.save();
    return;
  }

  if (claimed.attempts >= MAX_PUBLISH_ATTEMPTS) {
    claimed.status = 'failed'; claimed.errorCode = post.errorCode; claimed.errorMessage = post.errorMessage;
    await claimed.save();
    return;
  }

  // Exponential-ish backoff: 2min, 8min, 18min.
  claimed.status = 'pending';
  claimed.nextRetryAt = new Date(Date.now() + claimed.attempts * claimed.attempts * 2 * 60 * 1000);
  claimed.errorCode = post.errorCode; claimed.errorMessage = post.errorMessage;
  await claimed.save();
  post.status = 'scheduled'; // still due, will retry — not a terminal 'failed' yet
  await post.save();
}

async function reconcilePublishJobs() {
  const now = new Date();
  const due = await SocialPublishJob.find({
    status: 'pending',
    scheduledAt: { $lte: now },
    $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
  }).limit(50);
  for (const job of due) {
    try { await processDueJob(job); }
    catch (err) { console.error(`[instagram] publish job error (job ${job._id}):`, err.message); }
  }
  return { processed: due.length };
}

// ─── Tracking link click + redirect ──────────────────────────────────────────

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
    console.error('[instagram] could not resolve merchant WhatsApp number:', err.message);
  }
  return cachedWaNumber || null;
}

function hashValue(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function recordClickAndGetRedirect({ code, source, medium, ip, userAgent }) {
  const link = await TrackingLink.findOne({ code });
  if (!link) return null;
  const post = await InstagramPost.findById(link.instagramPostId).lean();
  if (!post) return null;

  const ipHash = hashValue(ip);
  const alreadyClickedBefore = ipHash ? await TrackingEvent.findOne({ trackingLinkId: link._id, eventType: 'click', 'metadata.ipHash': ipHash }) : null;

  await TrackingEvent.create({
    trackingLinkId: link._id, workspaceId: link.workspaceId, instagramPostId: post._id,
    eventType: 'click', metadata: { source: source || 'instagram', medium: medium || 'social', ipHash, userAgentHash: hashValue(userAgent) },
  });
  await TrackingLink.findByIdAndUpdate(link._id, { $inc: { clicks: 1, uniqueClicks: alreadyClickedBefore ? 0 : 1 } });

  const number = await getMerchantWaNumber();
  const message = `Hi, I'd like to claim the ${post.name} offer. Code: ${post.promotionCode}`;
  const waLink = number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : null;
  if (!link.destinationUrl && waLink) await TrackingLink.findByIdAndUpdate(link._id, { destinationUrl: waLink });

  return { waLink, post };
}

// ─── Inbound WhatsApp tracking-code detection ────────────────────────────────

// "IG-" prefix keeps this pattern unambiguous against the Referral
// Promotions feature's own bare-hex code format (see shared/referrals.js) —
// the two hooks run on every inbound message side by side and must never
// both match the same text.
const CODE_PATTERN = new RegExp(`code:\\s*(IG-${PROMO_CODE_PATTERN_SOURCE})`, 'i');
function extractTrackingCode(message) {
  const text = message?.text?.body || message?.button?.text || '';
  const match = text.match(CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

// Must run BEFORE shared/inbox.js#logInboundMessage in server.js's webhook
// handler — that hook auto-creates a Customer for every inbound message,
// which would make every phone look "already known" if it ran first (the
// exact bug this feature's sibling, Referral Promotions, hit and fixed).
async function handleInboundTrackingCode({ workspaceId, from, message, contactName }) {
  if (!workspaceId || !from || !message) return;
  const code = extractTrackingCode(message);
  if (!code) return;

  const post = await InstagramPost.findOne({ workspaceId, promotionCode: code });
  if (!post || !['published', 'publishing'].includes(post.status)) return;
  const link = post.trackingLinkId ? await TrackingLink.findById(post.trackingLinkId) : null;

  const existedBefore = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
  let customer = existedBefore;
  if (!customer) {
    const [firstname, ...rest] = (contactName || from).trim().split(/\s+/);
    customer = await Customer.create({ workspaceId, phone: from, firstname: firstname || from, lastname: rest.join(' ') });
  }

  await TrackingEvent.create({
    trackingLinkId: link?._id, workspaceId, instagramPostId: post._id,
    eventType: 'whatsapp_started', customerId: customer._id,
  }).catch(() => {});

  if (!existedBefore) {
    await TrackingEvent.create({
      trackingLinkId: link?._id, workspaceId, instagramPostId: post._id,
      eventType: 'customer_created', customerId: customer._id,
    }).catch(() => {});
  }
}

// ─── Attribution reconciliation (order/booking/payment/loyalty) ─────────────

async function reconcilePendingAttribution(workspaceId) {
  const filter = withWorkspace({}, workspaceId);
  const posts = await InstagramPost.find(filter).lean();
  let checked = 0;

  for (const post of posts) {
    const attributedCustomerIds = await TrackingEvent.find({ instagramPostId: post._id, eventType: 'customer_created' }).distinct('customerId');
    if (!attributedCustomerIds.length) continue;

    const alreadyOrdered = await TrackingEvent.find({ instagramPostId: post._id, eventType: 'order_created' }).distinct('customerId');
    const alreadyOrderedSet = new Set(alreadyOrdered.map(String));
    const pendingCustomerIds = attributedCustomerIds.filter(id => !alreadyOrderedSet.has(String(id)));
    if (!pendingCustomerIds.length) continue;

    for (const customerId of pendingCustomerIds) {
      checked++;
      const order = await Order.findOne({ customer: customerId, workspaceId: post.workspaceId, status: { $ne: 'cancelled' } }).sort({ createdAt: 1 }).lean();
      if (order) {
        await TrackingEvent.create({ trackingLinkId: post.trackingLinkId, workspaceId: post.workspaceId, instagramPostId: post._id, eventType: 'order_created', customerId, orderId: order._id, metadata: { revenue: order.total } }).catch(() => {});
        if (order.paymentStatus === 'paid') {
          await TrackingEvent.create({ trackingLinkId: post.trackingLinkId, workspaceId: post.workspaceId, instagramPostId: post._id, eventType: 'payment_completed', customerId, orderId: order._id, metadata: { revenue: order.total } }).catch(() => {});
        }
      }
      const booking = await Booking.findOne({ customerId, workspaceId: post.workspaceId, status: { $in: ['confirmed', 'completed'] } }).sort({ createdAt: 1 }).lean();
      if (booking) {
        await TrackingEvent.create({ trackingLinkId: post.trackingLinkId, workspaceId: post.workspaceId, instagramPostId: post._id, eventType: 'booking_created', customerId, bookingId: booking._id }).catch(() => {});
      }
      const customer = await Customer.findById(customerId).lean();
      if (customer?.loyaltyPoints > 0) {
        await TrackingEvent.create({ trackingLinkId: post.trackingLinkId, workspaceId: post.workspaceId, instagramPostId: post._id, eventType: 'loyalty_joined', customerId }).catch(() => {});
      }
    }
  }
  return { checked };
}

// ─── Scheduler bootstrap ─────────────────────────────────────────────────────

const TICK_INTERVAL_MS = +(process.env.INSTAGRAM_SCHEDULER_INTERVAL_MS || 2 * 60 * 1000);
const LOCK_ID = 'instagramScheduler';
let schedulerHandle = null;

async function acquireLock() {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + TICK_INTERVAL_MS - 30000);
  const renewed = await SchedulerLock.findOneAndUpdate({ _id: LOCK_ID, lockedUntil: { $lt: now } }, { $set: { lockedAt: now, lockedUntil } }, { new: true });
  if (renewed) return true;
  try { await SchedulerLock.create({ _id: LOCK_ID, lockedAt: now, lockedUntil }); return true; }
  catch (err) { if (err.code === 11000) return false; throw err; }
}

function startInstagramScheduler() {
  if (schedulerHandle) return;
  const tick = () => acquireLock().then(ok => ok && Promise.all([reconcilePublishJobs(), reconcilePendingAttribution()])).catch(err => console.error('[instagram] scheduler tick error:', err.message));
  tick();
  schedulerHandle = setInterval(tick, TICK_INTERVAL_MS);
}

// ─── Reporting ────────────────────────────────────────────────────────────────

async function getPostReport({ id, workspaceId }) {
  const post = await InstagramPost.findOne(scopedFilter(id, workspaceId)).lean();
  if (!post) throw new Error('Instagram promotion not found');
  const link = post.trackingLinkId ? await TrackingLink.findById(post.trackingLinkId).lean() : null;
  const events = await TrackingEvent.find({ instagramPostId: post._id }).lean();

  const countType = (type) => events.filter(e => e.eventType === type).length;
  const uniqueCustomers = (type) => new Set(events.filter(e => e.eventType === type && e.customerId).map(e => String(e.customerId))).size;
  const revenue = events.filter(e => e.eventType === 'order_created').reduce((s, e) => s + (e.metadata?.revenue || 0), 0);

  return {
    post, trackingLink: link,
    clicks: link?.clicks || 0, uniqueClicks: link?.uniqueClicks || 0,
    whatsappConversations: uniqueCustomers('whatsapp_started'),
    newCustomers: uniqueCustomers('customer_created'),
    ordersCreated: countType('order_created'),
    bookingsCreated: countType('booking_created'),
    paymentsCompleted: countType('payment_completed'),
    loyaltySignups: uniqueCustomers('loyalty_joined'),
    revenue,
  };
}

async function listPublishJobs({ workspaceId, instagramPostId }) {
  const filter = withWorkspace({}, workspaceId);
  if (instagramPostId) filter.instagramPostId = instagramPostId;
  return SocialPublishJob.find(filter).sort({ createdAt: -1 }).limit(50).lean();
}

module.exports = {
  isInstagramEnabled, getOrCreateEntitlement, setEntitlement,
  getSocialAccountStatus, getAuthorizeUrl, handleOAuthCallback, disconnectAccount,
  createPost, listPosts, getPost, updatePost, duplicatePost, cancelPost,
  generateContentForPost, refineContent,
  checkSchedulingLimit, schedulePost, publishPostNow,
  recordClickAndGetRedirect, handleInboundTrackingCode,
  reconcilePublishJobs, reconcilePendingAttribution, startInstagramScheduler,
  getPostReport, listPublishJobs,
};
