const axios       = require('axios');
const FormData    = require('form-data');
const mime        = require('mime-types');
const tokenManager = require('./tokenManager');
const { money }    = require('./currency');
const { getCurrency } = require('./settingsCache');

const WA_PHONE_ID = process.env.WA_PHONE_ID || '1032683093271618';
const WA_BASE     = 'https://graph.facebook.com/v25.0';
const WA_MSGS_URL = `${WA_BASE}/${WA_PHONE_ID}/messages`;

// Template names — override via env vars
const PROMO_TEMPLATE   = process.env.WA_PROMO_TEMPLATE   || 'waflow_promo';
const LOYALTY_TEMPLATE = process.env.WA_LOYALTY_TEMPLATE || 'waflow_loyalty';
const WINBACK_TEMPLATE = process.env.WA_WINBACK_TEMPLATE || 'waflow_winback';
const POST_PURCHASE_TEMPLATE = process.env.WA_POST_PURCHASE_TEMPLATE || 'waflow_post_purchase';
const POINTS_NUDGE_TEMPLATE = process.env.WA_POINTS_NUDGE_TEMPLATE || 'waflow_points_nudge';

let cachedWabaId = process.env.WA_WABA_ID || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

// WhatsApp Cloud API rejects WebP for message images/headers (error 131053).
// Link-based headers are accepted at send time but fail async, so filter up front.
function isSupportedImageLink(url) {
  return !!url && !/\.webp(?:$|\?)/i.test(url);
}

function getHeaders() {
  return {
    Authorization:  `Bearer ${tokenManager.getToken()}`,
    'Content-Type': 'application/json',
  };
}

async function waPost(body) {
  const res = await axios.post(WA_MSGS_URL, body, { headers: getHeaders() });
  return res.data;
}

async function getWabaId() {
  if (cachedWabaId) return cachedWabaId;

  // Approach 1: explicit env var (most reliable — user sets it once)
  if (process.env.WA_WABA_ID) {
    cachedWabaId = process.env.WA_WABA_ID;
    return cachedWabaId;
  }

  // Approach 2: list WABAs accessible to this token (works with messaging scope)
  try {
    const res = await axios.get(`${WA_BASE}/me/whatsapp_business_accounts`, {
      params: { access_token: tokenManager.getToken() },
    });
    const id = res.data?.data?.[0]?.id;
    if (id) { cachedWabaId = id; return cachedWabaId; }
  } catch (_) {}

  // Approach 3: query phone number ID for its WABA (requires business_management scope)
  try {
    const res = await axios.get(`${WA_BASE}/${WA_PHONE_ID}`, {
      params: { fields: 'whatsapp_business_account', access_token: tokenManager.getToken() },
    });
    const id = res.data?.whatsapp_business_account?.id;
    if (id) { cachedWabaId = id; return cachedWabaId; }
  } catch (_) {}

  throw new Error(
    'Cannot detect WABA ID automatically. ' +
    'Add WA_WABA_ID to your environment variables. ' +
    'Find it in: Meta Developer Portal → Your App → WhatsApp → API Setup → WhatsApp Business Account ID.'
  );
}

async function uploadFileBuffer(buffer, filename, contentType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, { filename, contentType });
  const res = await axios.post(
    `${WA_BASE}/${WA_PHONE_ID}/media`,
    form,
    { headers: { Authorization: getHeaders().Authorization, ...form.getHeaders() } },
  );
  return res.data.id;
}

async function uploadMediaFromUrl(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const buffer      = Buffer.from(res.data);
  const contentType = res.headers['content-type'] || 'image/jpeg';
  const ext         = mime.extension(contentType) || 'jpg';
  return uploadFileBuffer(buffer, `product.${ext}`, contentType);
}

// ── Category browsing ───────────────────────────────────────────────────────────

function getCategories(products) {
  return [...new Set(products.map(p => p.category))];
}

async function sendCategories(to, categories, promotion) {
  const rows = categories.map((c, i) => ({ id: `cat_${i}`, title: c.slice(0, 24) }));
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type:   'list',
      header: { type: 'text', text: `🏷️ ${promotion.name} — ${promotion.discountPercent}% OFF` },
      body:   { text: 'Choose a category to browse products on sale.' },
      footer: { text: 'Tap a category below' },
      action: {
        button:   'View Categories',
        sections: [{ title: 'Shop by Category', rows }],
      },
    },
  });
}

// ── Template management ───────────────────────────────────────────────────────

async function listTemplates() {
  const wabaId = await getWabaId();
  const res = await axios.get(`${WA_BASE}/${wabaId}/message_templates`, {
    headers: getHeaders(),
    params:  { limit: 100, fields: 'name,status,category,language,components' },
  });
  return res.data.data || [];
}

async function getTemplate(name) {
  const templates = await listTemplates();
  return templates.find(t => t.name === name) || null;
}

async function createTemplate(name, bodyText, category = 'MARKETING') {
  const wabaId = await getWabaId();
  const res = await axios.post(
    `${WA_BASE}/${wabaId}/message_templates`,
    {
      name,
      language:   'en',
      category,
      components: [
        { type: 'BODY', text: bodyText },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      ],
    },
    { headers: getHeaders() },
  );
  return res.data;
}

async function createPromoTemplate() {
  // Variables: {{1}} first name, {{2}} product name, {{3}} discount %, {{4}} sale price, {{5}} promo name, {{6}} currency code
  const body = 'Hi {{1}}! 🏷️ *{{2}}* is now *{{3}}% OFF* — only {{4}} {{6}}.\n\n{{5}}\n\nTap below to browse all products in this sale!';
  const wabaId = await getWabaId();
  const res = await axios.post(
    `${WA_BASE}/${wabaId}/message_templates`,
    {
      name: PROMO_TEMPLATE,
      language: 'en',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: body },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
      ],
    },
    { headers: getHeaders() },
  );
  return res.data;
}

async function deleteTemplate(name) {
  const wabaId = await getWabaId();
  const res = await axios.delete(`${WA_BASE}/${wabaId}/message_templates`, {
    headers: getHeaders(),
    params:  { name },
  });
  return res.data;
}

async function createLoyaltyTemplate() {
  // Variables: {{1}} first name, {{2}} loyalty points, {{3}} points worth, {{4}} currency code
  const body = 'Hi {{1}}! 💎 You have *{{2}} loyalty points* worth {{3}} {{4}}.\n\nPop in and use them on your next purchase — we\'d love to see you! 🛍️';
  return createTemplate(LOYALTY_TEMPLATE, body, 'MARKETING');
}

// Automated Flows templates (utils/flowScheduler.js) — proactive, time/inactivity
// triggered sends where the customer has almost certainly not messaged recently,
// so these must go out as pre-approved templates, never the interactive-message
// path used by manual campaigns.
async function createWinbackTemplate() {
  // Variables: {{1}} first name
  const body = 'Hi {{1}}! 👋 It\'s been a while since we\'ve seen you.\n\nCome back and check out what\'s new — we\'d love to have you again! 🛍️';
  const wabaId = await getWabaId();
  const res = await axios.post(
    `${WA_BASE}/${wabaId}/message_templates`,
    {
      name: WINBACK_TEMPLATE,
      language: 'en',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: body },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
      ],
    },
    { headers: getHeaders() },
  );
  return res.data;
}

async function createPostPurchaseTemplate() {
  // Variables: {{1}} first name, {{2}} loyalty points
  const body = 'Hi {{1}}! 🎉 Thanks for your order!\n\nYou now have *{{2}} loyalty points* — come back and use them on your next visit!';
  const wabaId = await getWabaId();
  const res = await axios.post(
    `${WA_BASE}/${wabaId}/message_templates`,
    {
      name: POST_PURCHASE_TEMPLATE,
      language: 'en',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: body },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
      ],
    },
    { headers: getHeaders() },
  );
  return res.data;
}

async function createPointsNudgeTemplate() {
  // Variables: {{1}} first name, {{2}} loyalty points
  const body = 'Hi {{1}}! 💎 You still have *{{2}} loyalty points* waiting to be used.\n\nCome in and redeem them before you forget!';
  const wabaId = await getWabaId();
  const res = await axios.post(
    `${WA_BASE}/${wabaId}/message_templates`,
    {
      name: POINTS_NUDGE_TEMPLATE,
      language: 'en',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: body },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
      ],
    },
    { headers: getHeaders() },
  );
  return res.data;
}

// ── Template sending ──────────────────────────────────────────────────────────

async function sendPromoTemplate(to, customer, product, promotion) {
  const discounted = (product.basePrice * (1 - promotion.discountPercent / 100)).toFixed(2);
  const currency = await getCurrency();
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     PROMO_TEMPLATE,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customer.firstname || 'Valued Customer' },
            { type: 'text', text: product.name },
            { type: 'text', text: String(promotion.discountPercent) },
            { type: 'text', text: discounted },
            { type: 'text', text: promotion.name },
            { type: 'text', text: currency },
          ],
        },
        // Dynamic quick-reply payload carries the promotion ID back via webhook
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `promo_${promotion._id}` }],
        },
      ],
    },
  });
}

async function sendLoyaltyTemplate(to, customerName, loyaltyPoints) {
  const worth = (loyaltyPoints / 10).toFixed(2);
  const currency = await getCurrency();
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     LOYALTY_TEMPLATE,
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: customerName || 'Valued Customer' },
          { type: 'text', text: String(loyaltyPoints) },
          { type: 'text', text: worth },
          { type: 'text', text: currency },
        ],
      }],
    },
  });
}

// Dynamic quick-reply payload carries flowId+enrollmentId back via webhook so
// the click can be correlated to the exact FlowEnrollment (see server.js's
// `flowbrowse_` button routing).
async function sendWinbackTemplate(to, customerName, flowId, enrollmentId) {
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     WINBACK_TEMPLATE,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: customerName || 'Valued Customer' }],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `flowbrowse_${flowId}_${enrollmentId}` }],
        },
      ],
    },
  });
}

async function sendPostPurchaseTemplate(to, customerName, loyaltyPoints, flowId, enrollmentId) {
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     POST_PURCHASE_TEMPLATE,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'Valued Customer' },
            { type: 'text', text: String(loyaltyPoints) },
          ],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `flowbrowse_${flowId}_${enrollmentId}` }],
        },
      ],
    },
  });
}

async function sendPointsNudgeTemplate(to, customerName, loyaltyPoints, flowId, enrollmentId) {
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     POINTS_NUDGE_TEMPLATE,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'Valued Customer' },
            { type: 'text', text: String(loyaltyPoints) },
          ],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `flowbrowse_${flowId}_${enrollmentId}` }],
        },
      ],
    },
  });
}

// ── Announcement + Carousel ────────────────────────────────────────────────────

// Pure payload builder — no `to`, no API call — so the exact same construction
// can be reused for a real send, a merchant-facing preview, and a test send.
function buildPromoAnnouncementPayload(customer, promotion, items) {
  const firstName = customer.firstname || 'there';
  const isPoints  = promotion.customerType === 'points';
  const isService = promotion.scope === 'services';
  const count     = items.length;

  const preview   = items.slice(0, 3).map(i => `• ${i.name}`).join('\n');
  const moreNote  = count > 3 ? `\n_...and ${count - 3} more_` : '';

  let priceNote;
  if (isService) {
    priceNote = isPoints ? `💎 Redeem ${promotion.pointsPrice} pts per session` : `💰 Book at a special rate`;
  } else {
    priceNote = isPoints
      ? `💎 Redeem ${promotion.pointsPrice} pts per item`
      : `🏷️ ${promotion.discountPercent}% OFF all items`;
  }

  const cta     = isService ? 'Book Now! 📅' : 'Shop Now! 🛍️';
  const tagline = promotion.description ? `\n${promotion.description.trim().slice(0, 200)}` : '';
  const body    = `Hi ${firstName}! ✨\n\n*${promotion.name}*${tagline}\n\n${preview}${moreNote}\n\n${priceNote}\n\nTap below to browse and ${isService ? 'book your slot' : 'add to cart'}.`;

  const firstImage = items.find(i => i.images?.[0] && isSupportedImageLink(i.images[0]))?.images?.[0];

  const interactive = {
    type:   'button',
    body:   { text: body },
    action: { buttons: [{ type: 'reply', reply: { id: `promo_${promotion._id}`, title: cta } }] },
  };
  if (firstImage) interactive.header = { type: 'image', image: { link: firstImage } };
  return interactive;
}

// One announcement per promotion (replaces per-product send).
// Works as outbound — tries interactive, falls back to template if outside 24h window.
async function sendPromoAnnouncement(to, customer, promotion, items) {
  const interactive = buildPromoAnnouncementPayload(customer, promotion, items);
  return waPost({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// Send one rich button card per product (image + price + Add to Cart).
// Uses image.link directly — no pre-upload needed.
async function sendProductCards(to, products, promotion) {
  const isPoints = promotion?.customerType === 'points';
  const disc     = promotion?.discountPercent || 0;
  const ptPrice  = promotion?.pointsPrice || 0;
  const currency = await getCurrency();

  for (const p of products) {
    const salePrice = isPoints ? null : +(p.basePrice * (1 - disc / 100)).toFixed(2);
    const priceStr  = isPoints
      ? `💎 ${ptPrice} pts`
      : disc > 0
        ? `${money(salePrice, currency)} _(was ${money(p.basePrice, currency)})_`
        : money(p.basePrice, currency);

    const bodyText = `*${p.name}*\n${priceStr}${p.description ? '\n\n' + p.description.slice(0, 150) : ''}`;

    const interactive = {
      type:   'button',
      body:   { text: bodyText },
      action: { buttons: [{ type: 'reply', reply: { id: `cart_${p._id}`, title: isPoints ? 'Redeem 💎' : 'Add to Cart 🛒' } }] },
    };

    if (p.images?.[0] && isSupportedImageLink(p.images[0])) {
      interactive.header = { type: 'image', image: { link: p.images[0] } };
    }

    await waPost({ messaging_product: 'whatsapp', to, type: 'interactive', interactive })
      .catch(e => console.warn(`Product card failed for ${p.name}:`, e.response?.data || e.message));
  }
}

// Product browsing for a promotion batch.
// NOTE: WhatsApp Cloud API has no documented 'carousel' interactive type (valid types are
// button, list, product, product_list, catalog_message, flow, call_permission_request).
// An earlier version of this function tried interactive.type:'carousel', which the API
// silently mishandled — only the first card ever reached the customer. Use the reliable,
// documented message types instead: individual rich cards (≤5) or a list message (>5).
async function sendProductCarousel(to, products, promotion, batchStart = 0) {
  const batch     = products.slice(batchStart, batchStart + 10);
  const remaining = products.length - batchStart - batch.length;

  const result = batch.length <= 5
    ? await sendProductCards(to, batch, promotion)
    : await sendCatalog(to, batch, promotion);

  if (remaining > 0) {
    await waPost({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type:   'button',
        body:   { text: `${remaining} more item${remaining !== 1 ? 's' : ''} in this promotion.` },
        // promotion is optional (flow-triggered browsing has none) — the id embedded here is
        // never actually parsed back out (handleMoreProducts uses pendingCatalogs' own state).
        action: { buttons: [{ type: 'reply', reply: { id: `more_${batchStart + batch.length}_${promotion?._id || 'none'}`, title: `See Next ${Math.min(remaining, 10)} →` } }] },
      },
    }).catch(() => {});
  }

  return result;
}

// Variant size/colour picker shown after customer taps "Add to Cart" on a product with variants.
async function sendVariantPicker(to, product, promotion) {
  const isPoints  = promotion?.customerType === 'points';
  const disc      = promotion?.discountPercent || 0;
  const ptPrice   = promotion?.pointsPrice || 0;
  const currency  = await getCurrency();

  const availableVariants = (product.variants || []).filter(v => v.stock > 0);

  const rows = availableVariants.map((v, i) => ({
    id:          `variant_${product._id}_${i}`,
    title:       [v.size, v.color].filter(Boolean).join(' · ').slice(0, 24) || `Option ${i + 1}`,
    description: isPoints
      ? `${ptPrice} pts · ${v.stock} in stock`.slice(0, 72)
      : `${money(product.basePrice * (1 - disc / 100), currency)} · ${v.stock} in stock`.slice(0, 72),
  }));

  // Also add a "No preference" option if the product itself has stock (base product)
  if (product.stock > 0 || !availableVariants.length) {
    rows.unshift({ id: `variant_${product._id}_base`, title: 'No preference', description: 'Standard / any available' });
  }

  return waPost({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type:   'list',
      header: { type: 'text', text: `Choose your option` },
      body:   { text: `*${product.name}* — pick your size/colour:` },
      footer: { text: 'Only in-stock options shown' },
      action: { button: 'View Options', sections: [{ title: 'Available Options', rows }] },
    },
  });
}

// ── Session (interactive) messages — require 24h conversation window ──────────

async function sendPromoMessage(to, product, promotion, loyaltyPoints) {
  const currency = await getCurrency();
  const discounted = (product.basePrice * (1 - promotion.discountPercent / 100)).toFixed(2);
  let bodyText = `🏷️ *${promotion.name}*\n\n*${product.name}*\n`;
  bodyText += `Was ${money(product.basePrice, currency)} → Now *${money(discounted, currency)}* (${promotion.discountPercent}% OFF!)`;
  if (product.description) bodyText += `\n\n${product.description}`;
  if (loyaltyPoints > 0) {
    const worth = (loyaltyPoints / 10).toFixed(2);
    bodyText += `\n\n💎 You have *${loyaltyPoints} loyalty points* (${money(worth, currency)}) — use them on this order!`;
  }

  const interactive = {
    type:   'button',
    body:   { text: bodyText },
    // promo_ID payload lets webhook know which promotion to open as a catalog
    action: { buttons: [{ type: 'reply', reply: { id: `promo_${promotion._id}`, title: 'Shop Now! 🛍️' } }] },
  };

  if (product.images?.[0]) {
    try {
      const mediaId = await uploadMediaFromUrl(product.images[0]);
      interactive.header = { type: 'image', image: { id: mediaId } };
    } catch (e) {
      console.warn(`Image upload failed for product ${product._id}:`, e.message);
    }
  }

  return waPost({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

// Sends a product catalog after customer expresses interest in a promotion.
// ≤10 products → WhatsApp List Message (tappable rows).
// >10 products  → numbered text (customer replies with numbers).
async function sendCatalog(to, products, promotion) {
  const isPoints   = promotion?.customerType === 'points';
  const pointsPrice = promotion?.pointsPrice || 0;
  const disc       = isPoints ? 1 : 1 - (promotion?.discountPercent || 0) / 100;
  const currency   = await getCurrency();

  // No promotion (e.g. flow-triggered browsing, see server.js's `flowbrowse_`
  // handler) gets plain "browse" copy instead of referencing a promotion that
  // doesn't exist.
  const label = !promotion
    ? '🛍️ Browse Products'
    : isPoints
      ? `💎 ${promotion.name} — ${pointsPrice} pts per item`
      : `🏷️ ${promotion.name} — ${promotion.discountPercent}% OFF`;

  if (products.length <= 10) {
    const rows = products.map(p => ({
      id:          `cart_${p._id}`,
      title:       p.name.slice(0, 24),
      description: isPoints
        ? `${pointsPrice} pts (worth ${money(p.basePrice, currency)})`.slice(0, 72)
        : `${money(p.basePrice * disc, currency)} (was ${money(p.basePrice, currency)})`.slice(0, 72),
    }));
    return waPost({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type:   'list',
        header: { type: 'text', text: label },
        body:   { text: isPoints
          ? 'Tap a product to redeem your points. You can add multiple items.'
          : 'Tap a product to add it to your cart. You can select multiple items one by one.' },
        footer: { text: isPoints ? 'Points required per item' : 'Prices shown are after discount' },
        action: {
          button:   isPoints ? 'View Products' : 'View Products',
          sections: [{ title: isPoints ? 'Products to Redeem' : 'Products on Sale', rows }],
        },
      },
    });
  }

  // Text fallback for large catalogs
  let text = `*${label}*\n\n${isPoints ? 'Reply with the number(s) to redeem:' : 'Reply with the number(s) to add to your cart:'}\n\n`;
  products.forEach((p, i) => {
    text += isPoints
      ? `${i + 1}. *${p.name}* — ${pointsPrice} pts _(worth ${money(p.basePrice, currency)})_\n`
      : `${i + 1}. *${p.name}* — ${money(p.basePrice * disc, currency)} _(was ${money(p.basePrice, currency)})_\n`;
  });
  text += '\nExamples: "1" · "1,3" · "all"';
  return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

async function sendLoyaltyReminder(to, customerName, loyaltyPoints) {
  const worth = (loyaltyPoints / 10).toFixed(2);
  const currency = await getCurrency();
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `👋 Hi *${customerName}*!\n\nYou have *${loyaltyPoints} loyalty points* worth *${money(worth, currency)}*! 🎁\n\nPop in and redeem them on your next purchase. We'd love to see you! 🛍️` },
      action: { buttons: [{ type: 'reply', reply: { id: 'shop_now', title: 'Shop Now! 🛍️' } }] },
    },
  });
}

// Sends available time slots for a service as a WhatsApp list message
async function sendServiceSlots(to, service, slots, promoId, isFree) {
  if (!slots.length) {
    return waPost({
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: `Sorry, there are no available slots for *${service.name}* right now. Please check back later!` },
    });
  }

  const prefix    = isFree ? 'reslot' : 'slot';
  const rows      = slots.slice(0, 10).map(s => ({
    id:          `${prefix}_${s._id}`,
    title:       `${s.date} · ${s.startTime}–${s.endTime}`.slice(0, 24),
    description: `${s.capacity - s.bookedCount} spot${s.capacity - s.bookedCount !== 1 ? 's' : ''} left`.slice(0, 72),
  }));

  const headerText = isFree
    ? `🔄 Rebook: ${service.name}`
    : `📅 Book: ${service.name}`;

  const bodyText = isFree
    ? 'Pick a new time slot — we\'ll move your booking at no charge.'
    : `${service.duration} min session · Choose your preferred time slot below.`;

  return waPost({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type:   'list',
      header: { type: 'text', text: headerText },
      body:   { text: bodyText },
      footer: { text: 'All times are confirmed instantly' },
      action: {
        button:   'View Slots',
        sections: [{ title: 'Available Slots', rows }],
      },
    },
  });
}

// Service promotion message — for cash promotions (one per service)
async function sendServicePromoMessage(to, customer, service, promotion) {
  const firstName = customer.firstname || 'Valued Customer';
  const isPoints  = promotion.customerType === 'points';
  const currency  = await getCurrency();
  const priceStr  = isPoints
    ? `💎 ${promotion.pointsPrice} pts`
    : `💰 ${money(service.basePrice, currency)} (${promotion.discountPercent}% OFF — was ${money(service.basePrice, currency)})`;

  const bodyText =
    `Hi ${firstName}! ✨\n\n` +
    `*${service.name}* is now available as part of our *${promotion.name}* offer!\n\n` +
    `${service.description ? service.description + '\n\n' : ''}` +
    `⏱ ${service.duration} min session\n${priceStr}\n\n` +
    `Tap below to see available time slots and book yours!`;

  try {
    return await waPost({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type:   'button',
        body:   { text: bodyText },
        action: { buttons: [{ type: 'reply', reply: { id: `promo_${promotion._id}`, title: 'Book Now! 📅' } }] },
      },
    });
  } catch (_) {
    return waPost({
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: bodyText + '\n\nReply *BOOK* to see available time slots.' },
    });
  }
}

// Cancellation notice sent to customer — offers free rebooking
async function sendRebookMessage(to, customerName, serviceName, slot, serviceId, bookingId) {
  const slotLabel = slot ? `${slot.date} at ${slot.startTime}` : 'your scheduled slot';
  const bodyText =
    `Hi ${customerName}! 😔\n\n` +
    `Unfortunately your booking for *${serviceName}* on *${slotLabel}* has been cancelled.\n\n` +
    `We\'d love to fit you in at another time — tap below to rebook at *no charge*!`;

  try {
    return await waPost({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type:   'button',
        body:   { text: bodyText },
        action: { buttons: [{ type: 'reply', reply: { id: `rebook_${serviceId}_${bookingId}`, title: 'Rebook Free 🔄' } }] },
      },
    });
  } catch (_) {
    return waPost({
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: bodyText },
    });
  }
}

// Pure payload builder — see buildPromoAnnouncementPayload for why this is split out.
function buildPointsPromoPayload(customer, promotion, products) {
  const firstName  = customer.firstname || 'Valued Customer';
  const pts        = customer.loyaltyPoints || 0;
  const pointsPrice = promotion.pointsPrice || 0;
  const itemNames  = products.slice(0, 5).map(p => `• ${p.name}`).join('\n');
  const more       = products.length > 5 ? `\n_...and ${products.length - 5} more items_` : '';

  const tagline = promotion.description ? `${promotion.description.trim().slice(0, 200)}\n\n` : '';
  const bodyText =
    `Hi ${firstName}! 💎 You have *${pts} loyalty points*!\n\n` +
    tagline +
    `Redeem *${pointsPrice} pts per item* in our *${promotion.name}* — no cash needed:\n\n` +
    `${itemNames}${more}\n\n` +
    `Tap below to browse and choose what you'd like!`;

  return {
    interactive: {
      type:   'button',
      body:   { text: bodyText },
      action: { buttons: [{ type: 'reply', reply: { id: `promo_${promotion._id}`, title: 'Shop Now! 💎' } }] },
    },
    textFallback: bodyText + '\n\nReply *SHOP* or tap our link to browse.',
  };
}

// One message per customer for points promotions — shows all products at once
async function sendPointsPromoMessage(to, customer, promotion, products) {
  const { interactive, textFallback } = buildPointsPromoPayload(customer, promotion, products);
  try {
    return await waPost({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
  } catch (_) {
    // Fallback plain text when outside the 24-hour window
    return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: textFallback } });
  }
}

async function sendGoodChoice(to, productId) {
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type:   'button',
      body:   { text: 'Great choice! 🎉 What would you like to do next?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'continue_shopping',        title: 'Keep Shopping'  } },
          { type: 'reply', reply: { id: `checkout_${productId||''}`, title: 'Checkout ✅'    } },
        ],
      },
    },
  });
}

module.exports = {
  waPost,
  uploadFileBuffer,
  uploadMediaFromUrl,
  getWabaId,
  // Category browsing
  getCategories,
  sendCategories,
  // Templates
  listTemplates,
  getTemplate,
  createPromoTemplate,
  createLoyaltyTemplate,
  createWinbackTemplate,
  createPostPurchaseTemplate,
  createPointsNudgeTemplate,
  deleteTemplate,
  sendPromoTemplate,
  sendLoyaltyTemplate,
  sendWinbackTemplate,
  sendPostPurchaseTemplate,
  sendPointsNudgeTemplate,
  // Catalog
  sendCatalog,
  // Announcement + carousel
  sendPromoAnnouncement,
  buildPromoAnnouncementPayload,
  sendProductCarousel,
  sendProductCards,
  sendVariantPicker,
  // Session messages (require 24h window)
  sendPromoMessage,
  sendPointsPromoMessage,
  buildPointsPromoPayload,
  sendServicePromoMessage,
  sendServiceSlots,
  sendRebookMessage,
  sendLoyaltyReminder,
  sendGoodChoice,
  // Template names (for status checks)
  PROMO_TEMPLATE,
  LOYALTY_TEMPLATE,
  WINBACK_TEMPLATE,
  POST_PURCHASE_TEMPLATE,
  POINTS_NUDGE_TEMPLATE,
};
