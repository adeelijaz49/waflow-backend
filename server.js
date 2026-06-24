require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const cors     = require("cors");
const multer   = require("multer");
const FormData = require("form-data");
const mime     = require("mime-types");
const Stripe   = require("stripe");
const mongoose = require("mongoose");

const app  = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_verify_token";
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/waflow";

// Stripe webhook needs raw body — before express.json()
app.post("/stripe-webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());
app.use(cors());

// ─── MongoDB ─────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err.message));

// ─── API routes ──────────────────────────────────────────────────────────────
app.use("/api/products",   require("./routes/products"));
app.use("/api/customers",  require("./routes/customers"));
app.use("/api/orders",     require("./routes/orders"));
app.use("/api/promotions", require("./routes/promotions"));

// ─── Stripe ──────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_SIGNING_SECRET = process.env.STRIPE_SIGNING_SECRET;

// ─── WhatsApp helpers ────────────────────────────────────────────────────────
const WA_PHONE_ID = process.env.WA_PHONE_ID || "1032683093271618";
const WA_MESSAGES_URL = `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`;

function waHeaders() {
  return {
    Authorization: `Bearer ${process.env.WA_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function waPost(body) {
  const res = await axios.post(WA_MESSAGES_URL, body, { headers: waHeaders() });
  return res.data;
}

async function uploadMediaToWhatsApp(file) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  const ct = file.mimetype && !file.mimetype.startsWith("text/")
    ? file.mimetype
    : mime.lookup(file.originalname) || "application/octet-stream";
  form.append("file", file.buffer, { filename: file.originalname, contentType: ct });
  const res = await axios.post(
    `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/media`,
    form,
    { headers: { Authorization: waHeaders().Authorization, ...form.getHeaders() } }
  );
  return res.data.id;
}

function sendImageWithButton(to, mediaId, bodyText, productId) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "image", image: { id: mediaId } },
      body:   { text: bodyText },
      action: { buttons: [{ type: "reply", reply: { id: `int_${productId}`, title: "Interested? 🛍️" } }] },
    },
  });
}

function sendGoodChoice(to) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Great choice! 🎉 What would you like to do next?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "continue_shopping", title: "Keep Shopping" } },
          { type: "reply", reply: { id: "checkout",          title: "Checkout ✅"   } },
        ],
      },
    },
  });
}

function generateProductId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── In-memory cart state (for Stripe flow) ──────────────────────────────────
const pendingProducts = new Map();
const carts = new Map();

// ─── Stripe helpers ──────────────────────────────────────────────────────────
function buildCartSummary(cart) {
  return cart.map((item, i) => `${i + 1}. ${item.name} — $${item.priceAud.toFixed(2)} AUD`).join("\n");
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
  return stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: lineItems,
    mode: "payment",
    success_url: `${APP_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${APP_URL}/payment-cancel`,
    metadata: { buyerPhone },
  });
}

// ─── Stripe webhook ──────────────────────────────────────────────────────────
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_SIGNING_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session    = event.data.object;
    const buyerPhone = session.metadata?.buyerPhone;
    const amountAud  = (session.amount_total / 100).toFixed(2);
    const points     = Math.floor(session.amount_total / 100);

    const cartItems = carts.get(buyerPhone) || [];
    carts.delete(buyerPhone);

    if (buyerPhone) {
      // Persist loyalty points + create order in MongoDB
      try {
        const Customer = require('./models/Customer');
        const Order    = require('./models/Order');
        const customer = await Customer.findOneAndUpdate(
          { phone: buyerPhone },
          { $inc: { loyaltyPoints: points } },
          { new: true }
        );
        if (customer && cartItems.length) {
          await Order.create({
            customer: customer._id,
            items: cartItems.map(item => ({
              productName: item.name,
              category:    item.description || 'General',
              quantity:    1,
              unitPrice:   item.priceAud,
            })),
            subtotal:            session.amount_total / 100,
            total:               session.amount_total / 100,
            status:              'confirmed',
            loyaltyPointsEarned: points,
          });
        }
      } catch (err) {
        console.error("MongoDB post-payment update error:", err.message);
      }

      await waPost({
        messaging_product: "whatsapp",
        to: buyerPhone,
        type: "text",
        text: { body: `✅ Payment of $${amountAud} AUD received! Your order is confirmed.\n\n🎁 You've earned *${points} loyalty points*! Thank you for shopping with us! 🎉` },
      }).catch(err => console.error("Payment confirmation error:", err.message));
    }
  }
  res.sendStatus(200);
}

// ─── WhatsApp webhook verification ──────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ─── WhatsApp incoming messages ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  console.log(`Incoming from ${from}:`, JSON.stringify(message, null, 2));

  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const buttonId = message.interactive.button_reply.id;
    console.log(`Button: ${buttonId} from ${from}`);

    if (buttonId.startsWith("int_")) {
      const productId = buttonId.slice(4);
      let product = pendingProducts.get(productId);
      if (product) {
        pendingProducts.delete(productId);
      } else {
        // Promotion flow — productId is a MongoDB ObjectId
        try {
          const Product = require('./models/Product');
          const dbProduct = await Product.findById(productId);
          if (dbProduct) {
            product = { name: dbProduct.name, priceAud: dbProduct.basePrice, description: dbProduct.category };
          }
        } catch (_) {}
      }
      if (product) {
        const cart = carts.get(from) || [];
        cart.push(product);
        carts.set(from, cart);
      }
      await sendGoodChoice(from).catch(err => console.error("sendGoodChoice error:", err.message));

    } else if (buttonId === "continue_shopping" || buttonId === "shop_now") {
      await waPost({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: "🛍️ Happy shopping! Take your time browsing our latest collection." },
      }).catch(err => console.error("continue_shopping error:", err.message));

    } else if (buttonId === "checkout") {
      const cart = carts.get(from);
      if (!cart?.length) {
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "Your cart is empty. Tap Interested? on a product to add it." } }).catch(() => {});
        return;
      }
      try {
        const session = await createCheckoutSession(from, cart);
        const total = cart.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
        await waPost({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: `🛒 *Your Order Summary*\n\n${buildCartSummary(cart)}\n\n*Total: $${total} AUD*\n\nPay securely:\n${session.url}` },
        }).catch(err => console.error("checkout link error:", err.message));
      } catch (err) {
        console.error("Stripe session error:", err.message);
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "Sorry, checkout is unavailable right now. Please try again." } }).catch(() => {});
      }
    }
  }
});

// ─── Send images from frontend ───────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

app.post("/send-message", upload.array("images"), async (req, res) => {
  const { to, message, productName, price } = req.body;
  if (!to || !message) return res.status(400).json({ success: false, error: "to and message required" });
  const files = req.files || [];

  try {
    if (!files.length) {
      const result = await waPost({ messaging_product: "whatsapp", to, type: "text", text: { body: message } });
      return res.json({ success: true, data: result });
    }

    const results = await Promise.all(files.map(async (file) => {
      const productId = generateProductId();
      pendingProducts.set(productId, { name: productName || message, priceAud: parseFloat(price) || 0, description: message });
      const mediaId = await uploadMediaToWhatsApp(file);
      return sendImageWithButton(to, mediaId, message, productId);
    }));
    return res.json({ success: true, data: results });
  } catch (err) {
    console.error("send-message error:", err.response?.data ?? err.message);
    return res.status(500).json({ success: false, error: err.response?.data ?? err.message });
  }
});

// ─── Payment pages ───────────────────────────────────────────────────────────
app.get("/payment-success", (req, res) => res.send("<h2>Payment successful! Return to WhatsApp. 🎉</h2>"));
app.get("/payment-cancel",  (req, res) => res.send("<h2>Payment cancelled. Return to WhatsApp to try again.</h2>"));
app.get("/",                (req, res) => res.send("Waflow backend running"));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
