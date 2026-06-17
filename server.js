require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const FormData = require("form-data");
const mime = require("mime-types");
const Stripe = require("stripe");

const app = express();

// Stripe webhook needs raw body — register it BEFORE express.json()
app.post("/stripe-webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_verify_token";
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_SIGNING_SECRET = process.env.STRIPE_SIGNING_SECRET;

const upload = multer({ storage: multer.memoryStorage() });

// ─── In-memory state ─────────────────────────────────────────────────────────

// productId -> { name, priceAud, description }
const pendingProducts = new Map();

// buyerPhone -> [{ name, priceAud, description }]
const carts = new Map();

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("Backend is running");
});

// ─── WhatsApp helpers ────────────────────────────────────────────────────────

const WA_PHONE_ID = process.env.WA_PHONE_ID;
const WA_TOKEN = process.env.WA_TOKEN;

const WA_MESSAGES_URL = `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`;

function waHeaders() {
  return { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" };
}

async function waPost(body) {
  const response = await axios.post(WA_MESSAGES_URL, body, { headers: waHeaders() });
  return response.data;
}

async function uploadMediaToWhatsApp(file) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  const contentType =
    file.mimetype && !file.mimetype.startsWith("text/")
      ? file.mimetype
      : mime.lookup(file.originalname) || "application/octet-stream";
  form.append("file", file.buffer, { filename: file.originalname, contentType });

  const response = await axios.post(
    `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/media`,
    form,
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, ...form.getHeaders() } }
  );
  return response.data.id;
}

// Each image gets a unique productId embedded in its button ID so we know exactly
// which product the buyer tapped "Interested?" on.
function sendImageWithButton(to, mediaId, bodyText, productId) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "image", image: { id: mediaId } },
      body: { text: bodyText },
      action: {
        buttons: [
          { type: "reply", reply: { id: `interested_${productId}`, title: "Interested?" } }
        ]
      }
    }
  });
}

function sendGoodChoice(to) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Good choice! What would you like to do next?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "continue_shopping", title: "Continue Shopping" } },
          { type: "reply", reply: { id: "checkout",          title: "Checkout"           } }
        ]
      }
    }
  });
}

function generateProductId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Stripe helpers ──────────────────────────────────────────────────────────

function buildCartSummary(cart) {
  return cart
    .map((item, i) => `${i + 1}. ${item.name} — $${item.priceAud.toFixed(2)} AUD`)
    .join("\n");
}

async function createCheckoutSession(buyerPhone, cart) {
  const lineItems = cart.map(item => ({
    price_data: {
      currency: "aud",
      product_data: { name: item.name, description: item.description || undefined },
      unit_amount: Math.round(item.priceAud * 100),
    },
    quantity: 1,
  }));

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: lineItems,
    mode: "payment",
    success_url: `${APP_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${APP_URL}/payment-cancel`,
    metadata: { buyerPhone },
  });

  return session;
}

// ─── Stripe webhook handler ──────────────────────────────────────────────────

async function handleStripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_SIGNING_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const buyerPhone = session.metadata?.buyerPhone;
    const amountAud = (session.amount_total / 100).toFixed(2);
    const rewardPoints = Math.floor(session.amount_total / 100);

    console.log(`Payment completed for ${buyerPhone}, amount: $${amountAud} AUD`);

    carts.delete(buyerPhone);

    if (buyerPhone) {
      await waPost({
        messaging_product: "whatsapp",
        to: buyerPhone,
        type: "text",
        text: {
          body: `✅ Payment of $${amountAud} AUD received! Your order is confirmed.\n\n🎁 You've earned *${rewardPoints} reward points*! Thank you for shopping with us! 🎉`
        }
      }).catch(err =>
        console.error("Error sending payment confirmation:", err.response?.data ?? err.message)
      );
    }
  }

  res.sendStatus(200);
}

// ─── Webhook (incoming messages from WhatsApp) ───────────────────────────────

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const entry   = req.body?.entry?.[0];
  const change  = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];

  if (!message) return;

  const from = message.from;
  console.log(`Incoming message from ${from}:`, JSON.stringify(message, null, 2));

  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const buttonId = message.interactive.button_reply.id;
    console.log(`Button tapped: ${buttonId} from ${from}`);

    if (buttonId.startsWith("interested_")) {
      const productId = buttonId.slice("interested_".length);
      const product = pendingProducts.get(productId);

      if (product) {
        const cart = carts.get(from) || [];
        cart.push(product);
        carts.set(from, cart);
        pendingProducts.delete(productId);
        console.log(`Added to cart for ${from}:`, product);
      }

      await sendGoodChoice(from).catch(err =>
        console.error("Error sending good choice:", err.response?.data ?? err.message)
      );

    } else if (buttonId === "continue_shopping") {
      await waPost({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: "Happy shopping! Take your time browsing." }
      }).catch(err =>
        console.error("Error sending continue shopping reply:", err.response?.data ?? err.message)
      );

    } else if (buttonId === "checkout") {
      const cart = carts.get(from);

      if (!cart || cart.length === 0) {
        await waPost({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: "Your cart is empty. Browse some products and tap Interested? to add them." }
        }).catch(err =>
          console.error("Error sending empty cart message:", err.response?.data ?? err.message)
        );
        return;
      }

      try {
        const session = await createCheckoutSession(from, cart);
        const summary = buildCartSummary(cart);
        const total = cart.reduce((sum, item) => sum + item.priceAud, 0).toFixed(2);

        await waPost({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: {
            body: `🛒 *Your Order Summary*\n\n${summary}\n\n*Total: $${total} AUD*\n\nTap the link below to pay securely:\n${session.url}`
          }
        }).catch(err =>
          console.error("Error sending checkout link:", err.response?.data ?? err.message)
        );
      } catch (err) {
        console.error("Error creating Stripe session:", err.message);
        await waPost({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: "Sorry, we couldn't process your checkout right now. Please try again." }
        }).catch(() => {});
      }
    }
  }
});

// ─── Send message ────────────────────────────────────────────────────────────

app.post("/send-message", upload.array("images"), async (req, res) => {
  console.log("====================================");
  console.log("POST /send-message called");
  console.log("Body:", req.body);
  console.log("Files:", req.files?.length ?? 0);

  const { to, message, productName, price } = req.body;

  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Both 'to' and 'message' are required" });
  }

  const files = req.files || [];

  if (files.length > 10) {
    return res.status(400).json({ success: false, error: "Maximum 10 images allowed" });
  }

  try {
    let result;

    if (files.length === 0) {
      result = await waPost({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message }
      });

    } else if (files.length === 1) {
      const productId = generateProductId();
      pendingProducts.set(productId, {
        name: productName || message,
        priceAud: parseFloat(price) || 0,
        description: message,
      });

      const mediaId = await uploadMediaToWhatsApp(files[0]);
      result = await sendImageWithButton(to, mediaId, message, productId);

    } else {
      // Multiple images: each gets its own productId (same name/price)
      const uploads = await Promise.all(files.map(async (file) => {
        const productId = generateProductId();
        pendingProducts.set(productId, {
          name: productName || message,
          priceAud: parseFloat(price) || 0,
          description: message,
        });
        const mediaId = await uploadMediaToWhatsApp(file);
        return { mediaId, productId };
      }));

      result = await Promise.all(
        uploads.map(({ mediaId, productId }) => sendImageWithButton(to, mediaId, message, productId))
      );
    }

    console.log("Response:", JSON.stringify(result, null, 2));
    console.log("====================================");
    return res.json({ success: true, data: result });

  } catch (error) {
    console.log("WhatsApp API error:");
    if (error.response) {
      console.log(JSON.stringify(error.response.data, null, 2));
      return res.status(error.response.status).json({ success: false, error: error.response.data });
    }
    console.log(error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Send template ───────────────────────────────────────────────────────────

app.post("/send-template", async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ success: false, error: "'to' is required" });
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: "hello_world", language: { code: "en_US" } }
      },
      { headers: waHeaders() }
    );
    return res.json({ success: true, data: response.data });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ success: false, error: error.response.data });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Payment result pages ────────────────────────────────────────────────────

app.get("/payment-success", (req, res) => {
  res.send("<h2>Payment successful! You can close this tab and return to WhatsApp.</h2>");
});

app.get("/payment-cancel", (req, res) => {
  res.send("<h2>Payment cancelled. Return to WhatsApp to try again.</h2>");
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
