// Orchestration for Promotion.sendFormat === 'carousel' — a fully parallel
// sibling to sendPromotion/previewPromotionMessage/sendTestMessage in
// shared/operations.js, not a branch inside them. Kept separate on purpose
// (see utils/whatsappCarousel.js's header comment for why): the only things
// imported from operations.js are withWorkspace/scopedFilter, tiny stable
// query-scoping helpers used everywhere in this codebase, not send logic.
const Promotion       = require('../models/Promotion');
const Customer        = require('../models/Customer');
const CampaignMessage = require('../models/CampaignMessage');
const { withWorkspace, scopedFilter } = require('./operations');
const { canSendMarketing } = require('./consent');
const { getCurrency } = require('../utils/settingsCache');
const { money }       = require('../utils/currency');
const {
  carouselTemplateName,
  ensureCarouselTemplateExists,
  buildCarouselSendComponents,
  sendCarouselTemplate,
} = require('../utils/whatsappCarousel');

// WhatsApp Cloud API rejects WebP for headers — same check as
// utils/whatsapp.js#isSupportedImageLink, duplicated here (one-line pure
// function) rather than imported, to keep this file's only dependency on
// ./whatsapp routed through utils/whatsappCarousel.js.
function isSupportedImageLink(url) {
  return !!url && !/\.webp(?:$|\?)/i.test(url);
}

// Every card in a carousel needs an image (Meta requires identical card
// structure), so items without a usable photo are excluded outright — not
// silently skipped later. Capped at 10 (Meta's max, also this app's existing
// per-batch convention elsewhere).
async function resolveCarouselEligibleItems(promotion) {
  const Product = require('../models/Product');
  const Service = require('../models/Service');

  let items;
  if (promotion.scope === 'services') {
    items = promotion.services?.length
      ? promotion.services
      : await Service.find(withWorkspace({ active: true }, promotion.workspaceId)).limit(10);
  } else {
    items = promotion.products?.length
      ? promotion.products
      : await Product.find(withWorkspace({ active: true }, promotion.workspaceId)).limit(10);
  }

  const eligible = items.filter(i => i.images?.[0] && isSupportedImageLink(i.images[0])).slice(0, 10);
  if (eligible.length < 2) {
    return {
      items: eligible,
      cardCount: eligible.length,
      ineligibleReason: `Carousel needs at least 2 ${promotion.scope} with a photo — this promotion currently has ${eligible.length} eligible. Add photos to more ${promotion.scope}, or use "Send as separate messages" instead.`,
    };
  }
  return { items: eligible, cardCount: eligible.length, ineligibleReason: null };
}

function buttonIdForItem(promotion) {
  return promotion.scope === 'services'
    ? (item) => `carouselsvc_${item._id}_${promotion._id}`
    : (item) => `cart_${item._id}`;
}

async function cardPreview(item, promotion, currency) {
  const isPoints = promotion.customerType === 'points';
  const disc     = promotion.discountPercent || 0;
  const priceStr = isPoints
    ? `💎 ${promotion.pointsPrice} pts`
    : `💰 ${money(item.basePrice * (1 - disc / 100), currency)}${disc ? ` (${disc}% OFF)` : ''}`;
  return { image: item.images[0], body: `*${item.name}*\n${priceStr}`, buttonLabel: 'View' };
}

async function previewCarouselPromotion({ promotionId, workspaceId }) {
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const { items, cardCount, ineligibleReason } = await resolveCarouselEligibleItems(promotion);

  if (ineligibleReason) {
    return { carousel: true, ineligible: true, reason: ineligibleReason, eligibleCount: items.length };
  }

  // Fire-and-forget pre-warm: opening the campaign panel starts Meta's review
  // for this card count before the merchant even clicks Send, best-effort
  // only (not a guarantee — a genuinely new item count picked right before
  // sending can still hit first-use latency, surfaced via a failed
  // CampaignMessage with a clear statusReason).
  ensureCarouselTemplateExists(cardCount, items.map(i => i.images[0])).catch(() => {});

  const isPoints = promotion.customerType === 'points';
  const currency = isPoints ? null : await getCurrency();
  const cards = await Promise.all(items.map(item => cardPreview(item, promotion, currency)));

  return {
    carousel: true,
    ineligible: false,
    headerBody: `Hi there! ✨ *${promotion.name}* — swipe to explore, tap a card to continue →`,
    footer: 'Reply STOP to unsubscribe',
    cards,
  };
}

async function sendCarouselTestMessage({ promotionId, phone, workspaceId }) {
  if (!phone) throw new Error('phone required');
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const { items, cardCount, ineligibleReason } = await resolveCarouselEligibleItems(promotion);
  if (ineligibleReason) throw new Error(ineligibleReason);

  await ensureCarouselTemplateExists(cardCount, items.map(i => i.images[0]));
  const cardComponents = await buildCarouselSendComponents(items, promotion, buttonIdForItem(promotion));
  await sendCarouselTemplate(phone, cardCount, ['there', promotion.name], cardComponents);
  return { success: true };
}

async function sendCarouselPromotion({ promotionId, customerIds, workspaceId }) {
  if (!customerIds?.length) throw new Error('customerIds required');
  const promotion = await Promotion.findOne(scopedFilter(promotionId, workspaceId)).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');

  const requested = await Customer.find(withWorkspace({ _id: { $in: customerIds } }, workspaceId));
  const customers = requested.filter(c => canSendMarketing(c) || promotion.isDemo || c.isDemo);
  const skippedOptedOut  = requested.filter(c => c.optedOut).length;
  const skippedNoConsent = requested.length - customers.length - skippedOptedOut;

  const { items, cardCount, ineligibleReason } = await resolveCarouselEligibleItems(promotion);
  if (ineligibleReason) {
    // Nothing sent — clear reason back to the caller rather than a partial/confusing send.
    return { success: false, error: ineligibleReason, sentCount: 0, skippedOptedOut, skippedNoConsent, errors: [], demoCount: 0 };
  }

  await ensureCarouselTemplateExists(cardCount, items.map(i => i.images[0]));
  const buttonIdFor = buttonIdForItem(promotion);
  const templateName = carouselTemplateName(cardCount);

  // Card content (images + body + button payloads) is identical for every
  // recipient — only the top-level body's firstname varies per customer, kept
  // separate below. Building this once, outside the loop, avoids re-fetching
  // and re-uploading every item's image to Meta once per recipient (would
  // otherwise be N-items x M-recipients uploads for one send). A real send
  // failure here (e.g. an image URL just went down) fails the whole batch
  // immediately rather than partially, same "surface it clearly" preference
  // as everywhere else in this feature.
  let cardComponents = null;
  const anyRealRecipient = customers.some(c => !(promotion.isDemo || c.isDemo));
  if (anyRealRecipient) {
    try {
      cardComponents = await buildCarouselSendComponents(items, promotion, buttonIdFor);
    } catch (err) {
      const failReason = err.response?.data?.error?.message || err.message;
      return { success: false, error: `Could not prepare carousel images: ${failReason}`, sentCount: 0, skippedOptedOut, skippedNoConsent, errors: [], demoCount: 0 };
    }
  }

  let sentCount = 0;
  let demoCount = 0;
  const errors = [];

  for (const customer of customers) {
    const demo = !!(promotion.isDemo || customer.isDemo);
    let sent = false;
    let result = null;
    let failReason;

    if (demo) {
      // Same zero-real-API-calls rule as sendPromotion for demo/fake data —
      // kept intentionally simple here (no order/points simulation) since a
      // brand-new send format is unlikely to be exercised via seeded demo
      // data first; that richer simulation lives only in shared/operations.js
      // and isn't duplicated here.
      result = { messages: [{ id: `democarousel_${Date.now()}_${Math.random().toString(36).slice(2)}` }] };
      sent = true; sentCount++; demoCount++;
    } else {
      try {
        result = await sendCarouselTemplate(customer.phone, cardCount, [customer.firstname || 'there', promotion.name], cardComponents);
        sent = true; sentCount++;
      } catch (err) {
        failReason = err.response?.data?.error?.message || err.message;
        errors.push({ customer: customer._id, error: failReason });
      }
    }

    await CampaignMessage.create({
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: customer.phone,
      workspaceId,
      wamid: result?.messages?.[0]?.id,
      messageType: 'template', // valid existing enum value — no CampaignMessage schema change needed
      templateName,
      status: sent ? (demo ? 'read' : 'sent') : 'failed',
      sentAt: sent ? new Date() : undefined,
      deliveredAt: demo && sent ? new Date() : undefined,
      readAt: demo && sent ? new Date() : undefined,
      statusReason: sent ? undefined : failReason,
    }).catch(() => {}); // best-effort, same as sendPromotion — a tracking-write failure must not break the send loop

    if (!demo) await new Promise(r => setTimeout(r, 300)); // real-send throttle only, same as sendPromotion
  }

  await Promotion.updateOne({ _id: promotion._id }, { sentAt: new Date(), sentCount, status: 'active' }).catch(() => {});
  return { success: true, sentCount, skippedOptedOut, skippedNoConsent, errors, demoCount };
}

// Webhook helper for a service carousel card tap ("Book Now" -> pick a time
// for THIS specific service). New prefix (carouselsvc_) because today's
// single-message service flow (handleServicePromoInterest in server.js) only
// ever shows services[0] regardless of how many are in the promotion — a
// carousel needs each card's button to open ITS OWN service's slots, which
// didn't exist before. Reuses the existing, unmodified sendServiceSlots and
// the existing shared pendingSlotSelections state (utils/state.js) so
// everything downstream of this tap (slot selection, booking, payment) is
// 100% already-proven code.
async function handleCarouselServiceSelection(from, serviceId, promoId, workspaceId) {
  try {
    const Service  = require('../models/Service');
    const TimeSlot = require('../models/TimeSlot');
    const { sendServiceSlots } = require('../utils/whatsapp');
    const { pendingSlotSelections } = require('../utils/state');

    const service = await Service.findOne(scopedFilter(serviceId, workspaceId));
    if (!service) return;
    const promo = promoId && promoId !== 'none' ? await Promotion.findOne(scopedFilter(promoId, workspaceId)) : null;

    const today = new Date().toISOString().slice(0, 10);
    const slots = await TimeSlot.find(withWorkspace({
      serviceId: service._id,
      date:      { $gte: today },
      $expr:     { $lt: ['$bookedCount', '$capacity'] },
    }, workspaceId)).sort({ date: 1, startTime: 1 }).limit(10);

    pendingSlotSelections.set(from, { service, promotion: promo, slots, isFree: false, workspaceId });
    await sendServiceSlots(from, service, slots, promo?._id?.toString() || 'none', false);
  } catch (err) {
    console.error('handleCarouselServiceSelection error:', err.message);
  }
}

module.exports = {
  resolveCarouselEligibleItems,
  previewCarouselPromotion,
  sendCarouselTestMessage,
  sendCarouselPromotion,
  handleCarouselServiceSelection,
};
