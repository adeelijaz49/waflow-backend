const axios = require('axios');
const FormData = require('form-data');
const mime = require('mime-types');

const WA_PHONE_ID = process.env.WA_PHONE_ID || '1032683093271618';
const WA_MESSAGES_URL = `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`;

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.WA_TOKEN || 'EAAfWyipnOp8BRn8ZCyv88bfLlCofC2neNjjZBNLS7oxFr6R744x48fBUtvZAXOM2sAm1ON9nZCKFeLpxZAtrOa3zNvECqsoGfIJQZCQ9mj3cawIRi8qJiifiUvKKsRyfuldBOuahuMTbXsbvnu3cUr0FljnyZBoAjxveT2p2jKG3IV8Kfanc92enlUJNv8y4jmRE73ss6DCqZBVkj8y6wHcmUwOlI8w0rVSGo6f1z8Aqv21Qa1OzgV573mp4erFgVa3kPKfw1jUwsiF4hYeWrZAWkDuMo'}`,
    'Content-Type': 'application/json',
  };
}

async function waPost(body) {
  const res = await axios.post(WA_MESSAGES_URL, body, { headers: getHeaders() });
  return res.data;
}

async function uploadFileBuffer(buffer, filename, contentType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, { filename, contentType });
  const res = await axios.post(
    `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/media`,
    form,
    { headers: { Authorization: getHeaders().Authorization, ...form.getHeaders() } }
  );
  return res.data.id;
}

async function uploadMediaFromUrl(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const buffer = Buffer.from(res.data);
  const contentType = res.headers['content-type'] || 'image/jpeg';
  const ext = mime.extension(contentType) || 'jpg';
  return uploadFileBuffer(buffer, `product.${ext}`, contentType);
}

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
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `int_${product._id}`, title: 'Interested? 🛍️' } },
      ],
    },
  };

  if (product.images && product.images[0]) {
    try {
      const mediaId = await uploadMediaFromUrl(product.images[0]);
      interactive.header = { type: 'image', image: { id: mediaId } };
    } catch (e) {
      console.warn(`Image upload failed for product ${product._id}:`, e.message);
    }
  }

  return waPost({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

async function sendLoyaltyReminder(to, customerName, loyaltyPoints) {
  const worth = (loyaltyPoints / 10).toFixed(2);
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `👋 Hi *${customerName}*!\n\nYou have *${loyaltyPoints} loyalty points* worth *$${worth} AUD* just waiting to be used! 🎁\n\nPop in and redeem them on your next purchase. We'd love to see you! 🛍️`,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'shop_now', title: 'Shop Now! 🛍️' } },
        ],
      },
    },
  });
}

async function sendGoodChoice(to, productId) {
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Great choice! 🎉 What would you like to do next?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'continue_shopping', title: 'Keep Shopping' } },
          { type: 'reply', reply: { id: `checkout_${productId || ''}`, title: 'Checkout ✅' } },
        ],
      },
    },
  });
}

module.exports = { waPost, uploadFileBuffer, uploadMediaFromUrl, sendPromoMessage, sendLoyaltyReminder, sendGoodChoice };
