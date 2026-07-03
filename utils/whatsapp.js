const axios       = require('axios');
const FormData    = require('form-data');
const mime        = require('mime-types');
const tokenManager = require('./tokenManager');

const WA_PHONE_ID = process.env.WA_PHONE_ID || '1032683093271618';
const WA_BASE     = 'https://graph.facebook.com/v25.0';
const WA_MSGS_URL = `${WA_BASE}/${WA_PHONE_ID}/messages`;

// Template names — override via env vars
const PROMO_TEMPLATE   = process.env.WA_PROMO_TEMPLATE   || 'waflow_promo';
const LOYALTY_TEMPLATE = process.env.WA_LOYALTY_TEMPLATE || 'waflow_loyalty';

let cachedWabaId = process.env.WA_WABA_ID || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  // Variables: {{1}} first name, {{2}} product name, {{3}} discount %, {{4}} sale price, {{5}} promo name
  const body = 'Hi {{1}}! 🏷️ *{{2}}* is now *{{3}}% OFF* — only ${{4}} AUD.\n\n{{5}}\n\nTap below to browse all products in this sale!';
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
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now! 🛍️' }] },
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
  const body = 'Hi {{1}}! 💎 You have *{{2}} loyalty points* worth ${{3}} AUD.\n\nPop in and use them on your next purchase — we\'d love to see you! 🛍️';
  return createTemplate(LOYALTY_TEMPLATE, body, 'MARKETING');
}

// ── Template sending ──────────────────────────────────────────────────────────

async function sendPromoTemplate(to, customer, product, promotion) {
  const discounted = (product.basePrice * (1 - promotion.discountPercent / 100)).toFixed(2);
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
        ],
      }],
    },
  });
}

// ── Session (interactive) messages — require 24h conversation window ──────────

async function sendPromoMessage(to, product, promotion, loyaltyPoints) {
  const discounted = (product.basePrice * (1 - promotion.discountPercent / 100)).toFixed(2);
  let bodyText = `🏷️ *${promotion.name}*\n\n*${product.name}*\n`;
  bodyText += `Was $${product.basePrice.toFixed(2)} → Now *$${discounted} AUD* (${promotion.discountPercent}% OFF!)`;
  if (product.description) bodyText += `\n\n${product.description}`;
  if (loyaltyPoints > 0) {
    const worth = (loyaltyPoints / 10).toFixed(2);
    bodyText += `\n\n💎 You have *${loyaltyPoints} loyalty points* ($${worth}) — use them on this order!`;
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

  if (products.length <= 10) {
    const rows = products.map(p => ({
      id:          `cart_${p._id}`,
      title:       p.name.slice(0, 24),
      description: isPoints
        ? `${pointsPrice} pts (worth $${p.basePrice.toFixed(2)} AUD)`.slice(0, 72)
        : `$${(p.basePrice * disc).toFixed(2)} AUD (was $${p.basePrice.toFixed(2)})`.slice(0, 72),
    }));
    return waPost({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type:   'list',
        header: { type: 'text', text: isPoints
          ? `💎 ${promotion.name} — ${pointsPrice} pts per item`
          : `🏷️ ${promotion.name} — ${promotion.discountPercent}% OFF` },
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
  let text = isPoints
    ? `💎 *${promotion.name}* — *${pointsPrice} pts per item*\n\nReply with the number(s) to redeem:\n\n`
    : `🛍️ *${promotion.name}* — *${promotion.discountPercent}% OFF*\n\nReply with the number(s) to add to your cart:\n\n`;
  products.forEach((p, i) => {
    text += isPoints
      ? `${i + 1}. *${p.name}* — ${pointsPrice} pts _(worth $${p.basePrice.toFixed(2)} AUD)_\n`
      : `${i + 1}. *${p.name}* — $${(p.basePrice * disc).toFixed(2)} AUD _(was $${p.basePrice.toFixed(2)})_\n`;
  });
  text += '\nExamples: "1" · "1,3" · "all"';
  return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

async function sendLoyaltyReminder(to, customerName, loyaltyPoints) {
  const worth = (loyaltyPoints / 10).toFixed(2);
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `👋 Hi *${customerName}*!\n\nYou have *${loyaltyPoints} loyalty points* worth *$${worth} AUD*! 🎁\n\nPop in and redeem them on your next purchase. We'd love to see you! 🛍️` },
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
  const priceStr  = isPoints
    ? `💎 ${promotion.pointsPrice} pts`
    : `💰 $${service.basePrice.toFixed(2)} AUD (${promotion.discountPercent}% OFF — was $${service.basePrice.toFixed(2)})`;

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

// One message per customer for points promotions — shows all products at once
async function sendPointsPromoMessage(to, customer, promotion, products) {
  const firstName  = customer.firstname || 'Valued Customer';
  const pts        = customer.loyaltyPoints || 0;
  const pointsPrice = promotion.pointsPrice || 0;
  const itemNames  = products.slice(0, 5).map(p => `• ${p.name}`).join('\n');
  const more       = products.length > 5 ? `\n_...and ${products.length - 5} more items_` : '';

  const bodyText =
    `Hi ${firstName}! 💎 You have *${pts} loyalty points*!\n\n` +
    `Redeem *${pointsPrice} pts per item* in our *${promotion.name}* — no cash needed:\n\n` +
    `${itemNames}${more}\n\n` +
    `Tap below to browse and choose what you'd like!`;

  try {
    return await waPost({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type:   'button',
        body:   { text: bodyText },
        action: { buttons: [{ type: 'reply', reply: { id: `promo_${promotion._id}`, title: 'Shop Now! 💎' } }] },
      },
    });
  } catch (_) {
    // Fallback plain text when outside the 24-hour window
    return waPost({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: bodyText + '\n\nReply *SHOP* or tap our link to browse.' },
    });
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
  deleteTemplate,
  sendPromoTemplate,
  sendLoyaltyTemplate,
  // Catalog
  sendCatalog,
  // Session messages (require 24h window)
  sendPromoMessage,
  sendPointsPromoMessage,
  sendServicePromoMessage,
  sendServiceSlots,
  sendRebookMessage,
  sendLoyaltyReminder,
  sendGoodChoice,
  // Template names (for status checks)
  PROMO_TEMPLATE,
  LOYALTY_TEMPLATE,
};
