require("dotenv").config();
const tokenManager = require("./utils/tokenManager");
const express  = require("express");
const axios    = require("axios");
const cors     = require("cors");
const multer   = require("multer");
const FormData = require("form-data");
const mime     = require("mime-types");
const Stripe   = require("stripe");
const mongoose = require("mongoose");

const { PORT, APP_URL } = require("./utils/config");
const { carts, pendingCatalogs, pendingAddressReqs, pendingPointsCheckouts, pendingSlotSelections, pendingServiceCheckouts } = require("./utils/state");

const app  = express();
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_verify_token";
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
app.use("/api/services",   require("./routes/services"));
app.use("/api/whatsapp",   require("./routes/whatsapp"));
app.use("/api/settings",  require("./routes/settings"));
app.use(require("./routes/pay"));

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

// ─── In-memory state ─────────────────────────────────────────────────────────
// carts / pendingCatalogs / pendingAddressReqs live in ./utils/state (shared with routes/pay.js)
const pendingProducts = new Map(); // randomId → { name, priceAud, description }

// ─── Stripe helpers ──────────────────────────────────────────────────────────
function buildCartSummary(cart) {
  return cart.map((item, i) => `${i + 1}. ${item.name} — $${item.priceAud.toFixed(2)} AUD`).join("\n");
}

const SHIPPING_COST_AUD = 0.5;

async function createPaymentIntent(buyerPhone, cart, shippingCost, subtotal, address) {
  const total = +(subtotal + shippingCost).toFixed(2);
  return stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: "aud",
    automatic_payment_methods: { enabled: true },
    metadata: {
      buyerPhone,
      subtotal:     String(subtotal),
      shippingCost: String(shippingCost),
      address:      address || "",
    },
  });
}

async function proceedToPayment(from, customer, cart) {
  const subtotal = +cart.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
  const total    = +(subtotal + SHIPPING_COST_AUD).toFixed(2);

  try {
    const pi = await createPaymentIntent(from, cart, SHIPPING_COST_AUD, subtotal, customer.address);
    await waPost({
      messaging_product: "whatsapp", to: from, type: "text",
      text: {
        body: `🛒 *Your Order Summary*\n\n${buildCartSummary(cart)}\n\nSubtotal: $${subtotal.toFixed(2)} AUD\nShipping: $${SHIPPING_COST_AUD.toFixed(2)} AUD\n*Total: $${total.toFixed(2)} AUD*\n\n📍 Delivering to:\n${customer.address}\n\nPay securely:\n${APP_URL}/pay/${pi.id}`,
      },
    });
    pendingCatalogs.delete(from);
  } catch (err) {
    console.error("Payment intent error:", err.message);
    await waPost({ messaging_product: "whatsapp", to: from, type: "text",
      text: { body: "Sorry, checkout is unavailable right now. Please try again." } }).catch(() => {});
  }
}

async function proceedToPointsConfirmation(from, customer, cart, promotion) {
  const totalPointsCost = cart.reduce((s, i) => s + (i.pointsCost || 0), 0) || (promotion?.pointsPrice || 0) * cart.length;
  if (customer.loyaltyPoints < totalPointsCost) {
    await waPost({ messaging_product: "whatsapp", to: from, type: "text",
      text: { body: `⚠️ You need ${totalPointsCost} pts but only have ${customer.loyaltyPoints} pts. Add fewer items or earn more points first.` } }).catch(() => {});
    return;
  }
  pendingPointsCheckouts.set(from, { cart, promotion, totalPointsCost, address: customer.address });
  const itemList  = cart.map(i => `• ${i.name}`).join("\n");
  const remaining = customer.loyaltyPoints - totalPointsCost;
  await waPost({
    messaging_product: "whatsapp", to: from, type: "text",
    text: { body: `💎 *Points Redemption Summary*\n\n${itemList}\n\n📍 Delivering to: ${customer.address}\n\n*${totalPointsCost} points will be deducted*\nYou have: ${customer.loyaltyPoints} pts → after: ${remaining} pts\n\nReply *YES* to confirm or *NO* to cancel.` },
  }).catch(() => {});
}

// ─── Stripe webhook ──────────────────────────────────────────────────────────
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_SIGNING_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const pi          = event.data.object;
    const buyerPhone   = pi.metadata?.buyerPhone;
    const amountAud    = (pi.amount / 100).toFixed(2);

    // ── Service booking payment ───────────────────────────────────────────────
    if (pi.metadata?.bookingType === "service") {
      const { serviceId, slotId, serviceName, slotLabel } = pi.metadata;
      if (buyerPhone) {
        try {
          const Customer = require('./models/Customer');
          const TimeSlot = require('./models/TimeSlot');
          const Booking  = require('./models/Booking');
          const customer = await Customer.findOne({ phone: buyerPhone });
          await TimeSlot.findByIdAndUpdate(slotId, { $inc: { bookedCount: 1 } });
          await Booking.create({
            serviceId,
            slotId,
            customerId:    customer?._id,
            phone:         buyerPhone,
            customerName:  customer ? `${customer.firstname || ''} ${customer.lastname || ''}`.trim() : buyerPhone,
            status:        'confirmed',
            paymentType:   'cash',
            amount:        pi.amount / 100,
            stripePaymentIntentId: pi.id,
          });
          await waPost({ messaging_product: "whatsapp", to: buyerPhone, type: "text",
            text: { body: `✅ *Booking Confirmed!*\n\n📋 ${serviceName}\n📅 ${slotLabel}\n💰 $${amountAud} AUD paid\n\nSee you then! 🎉` },
          }).catch(err => console.error("Service booking WA error:", err.message));
        } catch (err) {
          console.error("Service booking post-payment error:", err.message);
        }
      }
      return res.sendStatus(200);
    }

    const subtotal     = parseFloat(pi.metadata?.subtotal || '0');
    const shippingCost = parseFloat(pi.metadata?.shippingCost || '0');
    const address      = pi.metadata?.address || '';
    let loyaltySettings = { loyaltyPointsPerUnit: 100, minPointsPerPurchase: 100 };
    try { loyaltySettings = (await require('./models/Settings').findOne()) || loyaltySettings; } catch (_) {}
    const points = Math.max(loyaltySettings.minPointsPerPurchase, Math.round(subtotal * loyaltySettings.loyaltyPointsPerUnit));

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
            subtotal,
            shippingCost,
            shippingAddress:     address,
            total:               pi.amount / 100,
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

// ─── Promo catalog helpers ────────────────────────────────────────────────────
const { sendCatalog, getCategories, sendCategories, sendServiceSlots } = require("./utils/whatsapp");

async function handlePromoInterest(from, promoId) {
  try {
    const Promotion = require("./models/Promotion");
    const Product   = require("./models/Product");

    const promo = await Promotion.findById(promoId).populate("products").populate("services");
    if (!promo) return;

    // Service promotion — show time slots
    if (promo.scope === "services") {
      return handleServicePromoInterest(from, promo);
    }

    let products = promo.products || [];
    if (!products.length && promo.type === "store_wide") {
      products = await Product.find({ active: true }).limit(50).lean();
    }

    if (!products.length) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "Sorry, no products are available for this promotion right now." } });
      return;
    }

    const categories = getCategories(products);
    pendingCatalogs.set(from, { products, promotion: promo, categories });
    await sendCategories(from, categories, promo);
  } catch (err) {
    console.error("handlePromoInterest error:", err.message);
  }
}

async function handleCategorySelection(from, categoryIndex) {
  try {
    const catalog = pendingCatalogs.get(from);
    if (!catalog) return;

    const category = catalog.categories[categoryIndex];
    if (!category) return;

    const filtered = catalog.products.filter(p => p.category === category);
    catalog.displayedProducts = filtered;
    pendingCatalogs.set(from, catalog);

    if (!filtered.length) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "No products found in that category right now." } });
      return;
    }

    await sendCatalog(from, filtered, catalog.promotion);
  } catch (err) {
    console.error("handleCategorySelection error:", err.message);
  }
}

async function handleProductSelection(from, productId) {
  try {
    const catalog = pendingCatalogs.get(from);
    const Product = require("./models/Product");

    let p = catalog?.products.find(x => x._id.toString() === productId);
    if (!p) p = await Product.findById(productId).lean();
    if (!p) return;

    const promo      = catalog?.promotion;
    const isPoints   = promo?.customerType === 'points';
    const discFactor = (!isPoints && promo) ? 1 - promo.discountPercent / 100 : 1;
    const salePrice  = isPoints ? 0 : parseFloat((p.basePrice * discFactor).toFixed(2));
    const pointsCost = isPoints ? (promo?.pointsPrice || 0) : 0;

    const cart = carts.get(from) || [];
    cart.push({ name: p.name, priceAud: salePrice, pointsCost, description: p.description || p.category || "" });
    carts.set(from, cart);

    let bodyText;
    if (isPoints) {
      const totalPts = cart.reduce((s, i) => s + (i.pointsCost || 0), 0);
      bodyText = `✅ *${p.name}* added!\n💎 ${pointsCost} pts per item\n\n🛒 Cart: ${cart.length} item${cart.length !== 1 ? "s" : ""} · ${totalPts} pts total`;
    } else {
      const total = cart.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
      bodyText = `✅ *${p.name}* added to cart!\n💰 $${salePrice.toFixed(2)} AUD${promo ? ` (${promo.discountPercent}% OFF)` : ""}\n\n🛒 Cart: ${cart.length} item${cart.length !== 1 ? "s" : ""} · $${total} AUD total`;
    }

    await waPost({
      messaging_product: "whatsapp", to: from, type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            { type: "reply", reply: { id: "continue_shopping",                       title: "Keep Shopping 🛍️"   } },
            { type: "reply", reply: { id: isPoints ? "points_checkout" : "checkout", title: isPoints ? "Redeem Points 💎" : "Checkout ✅" } },
          ],
        },
      },
    });
  } catch (err) {
    console.error("handleProductSelection error:", err.message);
  }
}

// Shows available time slots when a customer taps a service promotion
async function handleServicePromoInterest(from, promo) {
  try {
    const Service  = require("./models/Service");
    const TimeSlot = require("./models/TimeSlot");

    const services = promo.services?.length ? promo.services : await Service.find({ active: true }).limit(1);
    if (!services.length) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "Sorry, no services are available for this promotion right now." } });
      return;
    }

    // Use first service in promotion (or only service)
    const service = services[0];
    const today   = new Date().toISOString().slice(0, 10);
    const slots   = await TimeSlot.find({
      serviceId:   service._id,
      date:        { $gte: today },
      $expr:       { $lt: ["$bookedCount", "$capacity"] },
    }).sort({ date: 1, startTime: 1 }).limit(10);

    pendingSlotSelections.set(from, { service, promotion: promo, slots, isFree: false });
    await sendServiceSlots(from, service, slots, promo._id.toString(), false);
  } catch (err) {
    console.error("handleServicePromoInterest error:", err.message);
  }
}

// Customer picked a time slot from a service promo
async function handleSlotSelection(from, slotId, isFree, oldBookingId) {
  try {
    const TimeSlot = require("./models/TimeSlot");
    const Service  = require("./models/Service");
    const Customer = require("./models/Customer");
    const Booking  = require("./models/Booking");

    const pending  = pendingSlotSelections.get(from);
    const slot     = await TimeSlot.findById(slotId);
    if (!slot) return;

    const service  = pending?.service || await Service.findById(slot.serviceId);
    const customer = await Customer.findOne({ phone: from });

    if (!slot || slot.bookedCount >= slot.capacity) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "⚠️ Sorry, that slot just got booked up. Please pick another time." } });
      return;
    }

    if (isFree) {
      // Rescheduling — free, no payment needed
      await TimeSlot.findByIdAndUpdate(slotId, { $inc: { bookedCount: 1 } });

      // If rescheduling an existing booking, mark old one rescheduled
      if (oldBookingId) {
        await Booking.findByIdAndUpdate(oldBookingId, { status: 'rescheduled' });
      }

      const booking = await Booking.create({
        serviceId:    service._id,
        slotId:       slot._id,
        customerId:   customer?._id,
        phone:        from,
        customerName: customer ? `${customer.firstname || ''} ${customer.lastname || ''}`.trim() : from,
        status:       'confirmed',
        paymentType:  'free',
        amount:       0,
      });

      pendingSlotSelections.delete(from);
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: `✅ *Booked!* Your appointment for *${service.name}* on *${slot.date} at ${slot.startTime}* is confirmed.\n\nSee you then! 🎉` } });
      return;
    }

    const promotion = pending?.promotion;
    const isPoints  = promotion?.customerType === 'points';

    if (isPoints) {
      const pointsCost = promotion.pointsPrice || 0;
      if ((customer?.loyaltyPoints || 0) < pointsCost) {
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: `⚠️ You need ${pointsCost} pts but only have ${customer?.loyaltyPoints || 0} pts.` } });
        return;
      }
      pendingServiceCheckouts.set(from, { service, slot, promotion, totalPointsCost: pointsCost });
      const remaining = (customer?.loyaltyPoints || 0) - pointsCost;
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: `💎 *Booking Summary*\n\n📋 ${service.name}\n📅 ${slot.date} at ${slot.startTime}–${slot.endTime}\n\n*${pointsCost} points will be deducted*\nYou have: ${customer?.loyaltyPoints || 0} pts → after: ${remaining} pts\n\nReply *YES* to confirm or *NO* to cancel.` } });
    } else {
      // Cash — create Stripe payment intent for the service
      const amount = service.basePrice || 0;
      const pi = await stripe.paymentIntents.create({
        amount:   Math.round(amount * 100),
        currency: "aud",
        automatic_payment_methods: { enabled: true },
        metadata: {
          bookingType: "service",
          buyerPhone:  from,
          serviceId:   service._id.toString(),
          slotId:      slot._id.toString(),
          serviceName: service.name,
          slotLabel:   `${slot.date} at ${slot.startTime}`,
        },
      });

      pendingSlotSelections.delete(from);
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: `📋 *${service.name}*\n📅 ${slot.date} at ${slot.startTime}–${slot.endTime}\n💰 $${amount.toFixed(2)} AUD\n\nPay securely to confirm your booking:\n${APP_URL}/pay/${pi.id}` } });
    }
  } catch (err) {
    console.error("handleSlotSelection error:", err.message);
  }
}

// Shows available slots for a rebook (free, initiated from cancellation WA message)
async function handleRebookRequest(from, serviceId, oldBookingId) {
  try {
    const Service  = require("./models/Service");
    const TimeSlot = require("./models/TimeSlot");

    const service = await Service.findById(serviceId);
    if (!service) return;

    const today = new Date().toISOString().slice(0, 10);
    const slots = await TimeSlot.find({
      serviceId,
      date:  { $gte: today },
      $expr: { $lt: ["$bookedCount", "$capacity"] },
    }).sort({ date: 1, startTime: 1 }).limit(10);

    pendingSlotSelections.set(from, { service, promotion: null, slots, isFree: true, oldBookingId });
    await sendServiceSlots(from, service, slots, null, true);
  } catch (err) {
    console.error("handleRebookRequest error:", err.message);
  }
}

// ─── WhatsApp incoming messages ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  console.log(`Incoming from ${from}:`, JSON.stringify(message, null, 2));

  // ── Template quick-reply (user tapped button on a template message) ──────────
  if (message.type === "button") {
    const payload = message.button?.payload || "";
    if (payload.startsWith("promo_")) {
      await handlePromoInterest(from, payload.slice(6));
    }
    return;
  }

  // ── Interactive messages ──────────────────────────────────────────────────────
  if (message.type === "interactive") {

    // List message row tapped
    if (message.interactive.type === "list_reply") {
      const rowId = message.interactive.list_reply?.id || "";
      if (rowId.startsWith("slot_")) {
        // Service time slot tapped (paid booking)
        await handleSlotSelection(from, rowId.slice(5), false, null);
      } else if (rowId.startsWith("reslot_")) {
        // Service time slot tapped (free rebook after cancellation)
        const pending  = pendingSlotSelections.get(from);
        await handleSlotSelection(from, rowId.slice(7), true, pending?.oldBookingId || null);
      } else if (rowId.startsWith("cart_")) {
        // Product row → add to cart
        await handleProductSelection(from, rowId.slice(5));
      } else if (rowId.startsWith("cat_")) {
        // Category row → show products within that category
        await handleCategorySelection(from, parseInt(rowId.slice(4), 10));
      }
      return;
    }

    // Button reply
    if (message.interactive.type === "button_reply") {
      const buttonId = message.interactive.button_reply.id;
      console.log(`Button: ${buttonId} from ${from}`);

      if (buttonId.startsWith("rebook_")) {
        // Customer tapped "Rebook Free" from cancellation message
        const parts     = buttonId.slice(7).split("_");
        const serviceId = parts[0];
        const bookingId = parts[1];
        await handleRebookRequest(from, serviceId, bookingId);

      } else if (buttonId.startsWith("promo_")) {
        // "Shop Now" / "Book Now" tapped on promo message → show catalog or slots
        await handlePromoInterest(from, buttonId.slice(6));

      } else if (buttonId.startsWith("int_")) {
        // Legacy: manual single-product send from /send-message endpoint
        const productId = buttonId.slice(4);
        const product   = pendingProducts.get(productId);
        if (product) {
          pendingProducts.delete(productId);
          const cart = carts.get(from) || [];
          cart.push(product);
          carts.set(from, cart);
        }
        await sendGoodChoice(from).catch(err => console.error("sendGoodChoice error:", err.message));

      } else if (buttonId === "continue_shopping" || buttonId === "shop_now") {
        const catalog = pendingCatalogs.get(from);
        if (catalog) {
          // Back to categories so they can browse more of the sale
          await sendCategories(from, catalog.categories, catalog.promotion)
            .catch(err => console.error("resend categories error:", err.message));
        } else {
          await waPost({
            messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "🛍️ Happy shopping! Take your time browsing our latest collection." },
          }).catch(err => console.error("continue_shopping error:", err.message));
        }

      } else if (buttonId === "checkout" || buttonId.startsWith("checkout_")) {
        const cart = carts.get(from);
        if (!cart?.length) {
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "Your cart is empty. Browse the sale and tap a product to add it." } }).catch(() => {});
          return;
        }
        const Customer = require("./models/Customer");
        const customer = await Customer.findOne({ phone: from });
        if (!customer) {
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "We couldn't find your profile. Please contact support to complete this order." } }).catch(() => {});
          return;
        }
        if (customer.address) {
          await proceedToPayment(from, customer, cart);
        } else {
          pendingAddressReqs.set(from, 'cash');
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "📍 Please reply with your delivery address (street, suburb, state, postcode) so we can calculate shipping." } }).catch(() => {});
        }

      } else if (buttonId === "points_checkout") {
        const cart = carts.get(from);
        if (!cart?.length) {
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "Your cart is empty. Tap a product to add it." } }).catch(() => {});
          return;
        }
        const Customer  = require("./models/Customer");
        const customer  = await Customer.findOne({ phone: from });
        if (!customer) {
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "We couldn't find your profile. Please contact support." } }).catch(() => {});
          return;
        }
        const catalog   = pendingCatalogs.get(from);
        const promotion = catalog?.promotion;
        if (customer.address) {
          await proceedToPointsConfirmation(from, customer, cart, promotion);
        } else {
          pendingAddressReqs.set(from, 'points');
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "📍 Please reply with your delivery address for this redemption order." } }).catch(() => {});
        }
      }
    }
    return;
  }

  // ── Text message ──────────────────────────────────────────────────────────────
  if (message.type === "text") {
    const text = message.text?.body?.trim() || "";

    // Awaiting YES/NO for points service booking confirmation
    if (pendingServiceCheckouts.has(from)) {
      const upper = text.toUpperCase();
      if (upper === 'YES') {
        const pending = pendingServiceCheckouts.get(from);
        pendingServiceCheckouts.delete(from);
        pendingSlotSelections.delete(from);
        try {
          const Customer = require('./models/Customer');
          const TimeSlot = require('./models/TimeSlot');
          const Booking  = require('./models/Booking');

          const customer = await Customer.findOneAndUpdate(
            { phone: from, loyaltyPoints: { $gte: pending.totalPointsCost } },
            { $inc: { loyaltyPoints: -pending.totalPointsCost } },
            { new: true }
          );
          if (!customer) {
            await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
              text: { body: '⚠️ Insufficient points. Booking could not be completed.' } }).catch(() => {});
            return;
          }
          await TimeSlot.findByIdAndUpdate(pending.slot._id, { $inc: { bookedCount: 1 } });
          await Booking.create({
            serviceId:    pending.service._id,
            slotId:       pending.slot._id,
            customerId:   customer._id,
            phone:        from,
            customerName: `${customer.firstname || ''} ${customer.lastname || ''}`.trim(),
            status:       'confirmed',
            paymentType:  'points',
            pointsUsed:   pending.totalPointsCost,
          });
          await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
            text: { body: `✅ *Booked!*\n\n📋 ${pending.service.name}\n📅 ${pending.slot.date} at ${pending.slot.startTime}\n💎 ${pending.totalPointsCost} points redeemed\n\nRemaining points: ${customer.loyaltyPoints} pts\n\nSee you then! 🎉` } }).catch(() => {});
        } catch (err) {
          console.error('Service points booking error:', err.message);
        }
      } else if (upper === 'NO') {
        pendingServiceCheckouts.delete(from);
        pendingSlotSelections.delete(from);
        await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
          text: { body: '👍 No worries! Your points are safe. Feel free to browse again anytime.' } }).catch(() => {});
      }
      return;
    }

    // Awaiting YES/NO for points redemption confirmation
    if (pendingPointsCheckouts.has(from)) {
      const upper = text.toUpperCase();
      if (upper === 'YES') {
        const pending = pendingPointsCheckouts.get(from);
        pendingPointsCheckouts.delete(from);
        carts.delete(from);
        pendingCatalogs.delete(from);
        try {
          const Customer = require('./models/Customer');
          const Order    = require('./models/Order');
          const customer = await Customer.findOneAndUpdate(
            { phone: from, loyaltyPoints: { $gte: pending.totalPointsCost } },
            { $inc: { loyaltyPoints: -pending.totalPointsCost } },
            { new: true }
          );
          if (!customer) {
            await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
              text: { body: '⚠️ Insufficient points. Your order could not be processed.' } }).catch(() => {});
            return;
          }
          if (pending.cart.length) {
            await Order.create({
              customer:         customer._id,
              items:            pending.cart.map(i => ({ productName: i.name, category: i.description || 'General', quantity: 1, unitPrice: 0 })),
              subtotal:         0,
              shippingCost:     0,
              shippingAddress:  pending.address,
              total:            0,
              loyaltyPointsUsed:  pending.totalPointsCost,
              loyaltyDiscount:    pending.totalPointsCost,
              status:           'confirmed',
              loyaltyPointsEarned: 0,
            });
          }
          await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
            text: { body: `✅ *Order Confirmed!*\n\n💎 ${pending.totalPointsCost} points redeemed successfully.\n📍 Delivering to: ${pending.address}\n\nRemaining points: ${customer.loyaltyPoints} pts\n\nThank you for shopping with us! 🎉` } }).catch(() => {});
        } catch (err) {
          console.error('Points redemption error:', err.message);
        }
      } else if (upper === 'NO') {
        pendingPointsCheckouts.delete(from);
        carts.delete(from);
        pendingCatalogs.delete(from);
        await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
          text: { body: '👍 No worries! Your points are safe. Feel free to browse again anytime.' } }).catch(() => {});
      }
      return;
    }

    // Awaiting delivery address after "Checkout" was tapped
    if (pendingAddressReqs.has(from)) {
      const addrType = pendingAddressReqs.get(from);
      pendingAddressReqs.delete(from);
      const cart = carts.get(from);
      if (!cart?.length) {
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "Your cart is empty. Browse the sale and tap a product to add it." } }).catch(() => {});
        return;
      }
      const Customer = require("./models/Customer");
      const customer = await Customer.findOneAndUpdate({ phone: from }, { address: text }, { new: true });
      if (!customer) {
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "We couldn't find your profile. Please contact support to complete this order." } }).catch(() => {});
        return;
      }
      if (addrType === 'points') {
        const catalog = pendingCatalogs.get(from);
        await proceedToPointsConfirmation(from, customer, cart, catalog?.promotion);
      } else {
        await proceedToPayment(from, customer, cart);
      }
      return;
    }

    // Number selection from a large (>10 item) category catalog
    const catalog = pendingCatalogs.get(from);
    if (!catalog) return;

    const products = catalog.displayedProducts || catalog.products;
    let indices    = [];

    if (text.toLowerCase() === "all") {
      indices = products.map((_, i) => i);
    } else {
      indices = text.split(/[\s,]+/)
        .map(p => parseInt(p, 10) - 1)
        .filter(n => !isNaN(n) && n >= 0 && n < products.length);
      indices = [...new Set(indices)];
    }

    if (!indices.length) return; // not a product selection, ignore

    // Add each selected product sequentially
    const isPoints   = catalog.promotion?.customerType === 'points';
    const pointsPrice = catalog.promotion?.pointsPrice || 0;
    const disc       = isPoints ? 1 : 1 - (catalog.promotion?.discountPercent || 0) / 100;
    const cart       = carts.get(from) || [];
    let summary      = "";
    for (const i of indices) {
      const p         = products[i];
      const salePrice = isPoints ? 0 : parseFloat((p.basePrice * disc).toFixed(2));
      cart.push({ name: p.name, priceAud: salePrice, pointsCost: isPoints ? pointsPrice : 0, description: p.description || p.category || "" });
      summary += isPoints
        ? `✅ ${p.name} — ${pointsPrice} pts\n`
        : `✅ ${p.name} — $${salePrice.toFixed(2)} AUD\n`;
    }
    carts.set(from, cart);
    const totalDisplay = isPoints
      ? `${cart.reduce((s, i) => s + (i.pointsCost || 0), 0)} pts total`
      : `$${cart.reduce((s, i) => s + i.priceAud, 0).toFixed(2)} AUD total`;

    await waPost({
      messaging_product: "whatsapp", to: from, type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `Added to cart:\n${summary}\n🛒 ${cart.length} item${cart.length !== 1 ? "s" : ""} · ${totalDisplay}\n\nWhat would you like to do?`,
        },
        action: {
          buttons: [
            { type: "reply", reply: { id: "continue_shopping",                       title: "Keep Shopping 🛍️"   } },
            { type: "reply", reply: { id: isPoints ? "points_checkout" : "checkout", title: isPoints ? "Redeem Points 💎" : "Checkout ✅" } },
          ],
        },
      },
    }).catch(err => console.error("cart confirm error:", err.message));
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

app.get("/", (req, res) => res.send("Waflow backend running"));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  tokenManager.init(); // validate + auto-refresh WA token in background
});
