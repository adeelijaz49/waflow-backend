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
const { carts, pendingCatalogs, pendingAddressReqs, pendingPointsCheckouts, pendingSlotSelections, pendingServiceCheckouts, pendingVariantSelections, pendingPayLaterSlots } = require("./utils/state");
const { money } = require("./utils/currency");
const { getCurrency } = require("./utils/settingsCache");
const CampaignMessage = require("./models/CampaignMessage");
const FlowEnrollment  = require("./models/FlowEnrollment");
const MessageNode     = require("./models/MessageNode");

const app  = express();
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_verify_token";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/waflow";

// Stripe webhook needs raw body — before express.json()
app.post("/stripe-webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // OAuth token/authorize endpoints use form-encoded bodies
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
app.use("/api/flows",      require("./routes/flows"));
app.use("/api/message-nodes", require("./routes/messageNodes"));
app.use("/api/services",   require("./routes/services"));
app.use("/api/whatsapp",   require("./routes/whatsapp"));
app.use("/api/settings",  require("./routes/settings"));
app.use(require("./routes/pay"));

// ─── MCP (Model Context Protocol) — lets Claude connect as tools ────────────
app.use(require("./mcp/oauth").router);
app.use("/mcp", require("./mcp"));

// ─── ChatGPT Custom GPT Actions — REST + OpenAPI, separate API-key auth ─────
app.use("/gpt-api", require("./gpt/routes"));

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

// ─── Campaign message tracking (delivery status + click correlation) ────────
// Rank for monotonic status updates — never let an out-of-order webhook event
// downgrade an already-more-advanced status (e.g. a late "sent" arriving after
// "read" already landed).
const STATUS_RANK = { queued: 0, sent: 1, failed: 1, delivered: 2, read: 3 };

async function handleStatusCallbacks(statuses) {
  for (const s of statuses) {
    try {
      const cm = await CampaignMessage.findOne({ wamid: s.id });
      if (!cm) continue;
      if ((STATUS_RANK[s.status] ?? 0) < (STATUS_RANK[cm.status] ?? 0)) continue;

      const update = { status: s.status };
      const ts = s.timestamp ? new Date(+s.timestamp * 1000) : new Date();
      if (s.status === "sent")      update.sentAt = ts;
      if (s.status === "delivered") update.deliveredAt = ts;
      if (s.status === "read")      update.readAt = ts;
      if (s.status === "failed")    update.statusReason = s.errors?.[0]?.title || s.errors?.[0]?.message;

      await CampaignMessage.findByIdAndUpdate(cm._id, update);
    } catch (err) {
      console.error("handleStatusCallbacks error:", err.message);
    }
  }
}

// Correlates an inbound button tap back to the CampaignMessage that prompted it —
// precise match via the wamid in `context.id` (the message being replied to), with
// a (promotion, customer, most-recent-sent) fallback if context is unavailable.
async function correlateClick({ from, wamid, promotionId }) {
  try {
    let cm = null;
    if (wamid) {
      cm = await CampaignMessage.findOneAndUpdate({ wamid }, { clickedAt: new Date() }, { new: true });
    }
    if (!cm && promotionId) {
      const Customer = require("./models/Customer");
      const customer = await Customer.findOne({ phone: from });
      if (customer) {
        cm = await CampaignMessage.findOneAndUpdate(
          { promotion: promotionId, customer: customer._id, status: { $in: ["sent", "delivered", "read"] } },
          { clickedAt: new Date() },
          { sort: { createdAt: -1 }, new: true },
        );
      }
    }
    return cm;
  } catch (err) {
    console.error("correlateClick error:", err.message);
    return null;
  }
}

// Handles a tap on a branching MessageNode button (payload msgnode_<nodeId>_<position>,
// see models/MessageNode.js). Single atomic claim scoped by wamid+respondedAt —
// a losing concurrent/duplicate tap (genuine double-tap, or a Meta webhook
// redelivery) gets null back and no-ops; first tap wins, matching how a
// WhatsApp client's buttons aren't re-tappable once used. Called from both the
// entry-node dispatch (message.type === "button", always a template reply) and
// the deeper-node dispatch (interactive.button_reply, always a free-form reply)
// so the two webhook shapes can't drift into two separate implementations.
async function handleMessageNodeTap({ from, wamid, nodeId, position }) {
  try {
    if (!wamid) return;
    const claimed = await CampaignMessage.findOneAndUpdate(
      { wamid, respondedAt: null },
      { $set: { clickedAt: new Date(), respondedAt: new Date(), clickedButtonPosition: position } },
      { new: true },
    );
    if (!claimed) return; // already handled

    const node = await MessageNode.findById(nodeId);
    const button = node?.buttons.find(b => b.position === position);
    if (!button) return;

    const { type, targetNodeId } = button.nextAction;

    if (type === "send_message" && targetNodeId) {
      const targetNode = await MessageNode.findById(targetNodeId);
      if (!targetNode) return;

      const Customer = require("./models/Customer");
      const customer = await Customer.findById(claimed.customer);
      if (!customer || customer.optedOut) return; // opt-out enforced at every node, not just the entry message

      // The send itself gets its own try/catch (matching flowScheduler.js's
      // processEnrollment pattern) so a failed WhatsApp call still results in a
      // CampaignMessage row (status:'failed') rather than silently recording
      // nothing — the outer try/catch around this whole function would
      // otherwise swallow a send failure before reaching CampaignMessage.create.
      const { sendMessageNodeFollowUp } = require("./utils/whatsapp");
      let sendStatus = "sent";
      let statusReason;
      let followUpWamid;
      try {
        const result = await sendMessageNodeFollowUp(from, targetNode, [customer.firstname || "there"]);
        followUpWamid = result?.messages?.[0]?.id;
      } catch (err) {
        sendStatus = "failed";
        statusReason = err.message;
      }
      await CampaignMessage.create({
        kind: "flow", flow: claimed.flow, flowEnrollment: claimed.flowEnrollment,
        customer: customer._id, phone: from,
        wamid: followUpWamid, messageType: "interactive", messageNode: targetNode._id,
        status: sendStatus, statusReason, sentAt: new Date(),
      }).catch(() => {});
    } else if (type === "end_flow" && claimed.flowEnrollment) {
      await FlowEnrollment.findByIdAndUpdate(claimed.flowEnrollment, { state: "completed" }).catch(() => {});
    } else if (type === "apply_discount" || type === "redeem_points") {
      // No standalone "apply a one-off discount to this customer" or "mark
      // points redeemed outside a real order" operation exists yet to call —
      // discounts today only exist baked into a whole Promotion send, and
      // points redemption only happens via the full WhatsApp checkout flow.
      // Building either is a separate, larger feature than this branching
      // spec covers. Recorded as a visible, reportable outcome rather than
      // silently doing nothing, so a merchant configuring this isn't left
      // wondering why the tap produced no effect.
      console.warn(`MessageNode action "${type}" tapped but not yet implemented (node ${nodeId}, position ${position})`);
      await CampaignMessage.create({
        kind: "flow", flow: claimed.flow, flowEnrollment: claimed.flowEnrollment,
        customer: claimed.customer, phone: from,
        messageType: "text", status: "failed", statusReason: `action_not_implemented:${type}`, sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (err) {
    console.error("handleMessageNodeTap error:", err.message);
  }
}

// ─── Stripe helpers ──────────────────────────────────────────────────────────
function buildCartSummary(cart, currency) {
  return cart.map((item, i) => `${i + 1}. ${item.name} — ${money(item.priceAud, currency)}`).join("\n");
}

const SHIPPING_COST = 0.5;

async function createPaymentIntent(buyerPhone, cart, shippingCost, subtotal, address, currency, promotionId, campaignMessageId) {
  const total = +(subtotal + shippingCost).toFixed(2);
  return stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: {
      buyerPhone,
      subtotal:     String(subtotal),
      shippingCost: String(shippingCost),
      address:      address || "",
      promotionId:       promotionId ? String(promotionId) : "",
      campaignMessageId: campaignMessageId ? String(campaignMessageId) : "",
    },
  });
}

async function proceedToPayment(from, customer, cart) {
  const currency = await getCurrency();
  const subtotal = +cart.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
  const total    = +(subtotal + SHIPPING_COST).toFixed(2);
  const catalog  = pendingCatalogs.get(from);
  const promotion = catalog?.promotion || null;
  const campaignMessageId = catalog?.campaignMessageId || null;
  const source = promotion ? "campaign" : "product";

  try {
    const pi = await createPaymentIntent(from, cart, SHIPPING_COST, subtotal, customer.address, currency, promotion?._id, campaignMessageId);

    // Visible in the dashboard immediately as pending — the Stripe webhook updates
    // this same document (matched by stripePaymentIntentId) to paid/failed.
    const Order = require("./models/Order");
    await Order.create({
      customer: customer._id,
      items: cart.map(item => ({ productName: item.name, category: item.description || "General", quantity: 1, unitPrice: item.priceAud })),
      subtotal, shippingCost: SHIPPING_COST, shippingAddress: customer.address, total,
      status: "pending", paymentStatus: "pending", source,
      promotion: promotion?._id || undefined,
      campaignMessage: campaignMessageId || undefined,
      stripePaymentIntentId: pi.id,
    });

    await waPost({
      messaging_product: "whatsapp", to: from, type: "text",
      text: {
        body: `🛒 *Your Order Summary*\n\n${buildCartSummary(cart, currency)}\n\nSubtotal: ${money(subtotal, currency)}\nShipping: ${money(SHIPPING_COST, currency)}\n*Total: ${money(total, currency)}*\n\n📍 Delivering to:\n${customer.address}\n\nPay securely:\n${APP_URL}/pay/${pi.id}`,
      },
    });
    pendingCatalogs.delete(from);
  } catch (err) {
    console.error("Payment intent error:", err.message);
    await waPost({ messaging_product: "whatsapp", to: from, type: "text",
      text: { body: "Sorry, checkout is unavailable right now. Please try again." } }).catch(() => {});
  }
}

async function proceedToPointsConfirmation(from, customer, cart) {
  const catalog = pendingCatalogs.get(from);
  const promotion = catalog?.promotion || null;
  const campaignMessageId = catalog?.campaignMessageId || null;
  const totalPointsCost = cart.reduce((s, i) => s + (i.pointsCost || 0), 0) || (promotion?.pointsPrice || 0) * cart.length;
  if (customer.loyaltyPoints < totalPointsCost) {
    await waPost({ messaging_product: "whatsapp", to: from, type: "text",
      text: { body: `⚠️ You need ${totalPointsCost} pts but only have ${customer.loyaltyPoints} pts. Add fewer items or earn more points first.` } }).catch(() => {});
    return;
  }
  pendingPointsCheckouts.set(from, { cart, promotion, campaignMessageId, totalPointsCost, address: customer.address });
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

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    const Order = require('./models/Order');
    await Order.findOneAndUpdate({ stripePaymentIntentId: pi.id }, { paymentStatus: 'failed' }).catch(() => {});
    return res.sendStatus(200);
  }

  if (event.type === "payment_intent.succeeded") {
    const pi          = event.data.object;
    const buyerPhone   = pi.metadata?.buyerPhone;
    const amountAud    = (pi.amount / 100).toFixed(2);
    const currency     = await getCurrency();

    // ── Service booking payment ───────────────────────────────────────────────
    if (pi.metadata?.bookingType === "service") {
      const { serviceId, slotId, serviceName, slotLabel } = pi.metadata;
      if (buyerPhone) {
        try {
          const Customer = require('./models/Customer');
          const TimeSlot = require('./models/TimeSlot');
          const Booking  = require('./models/Booking');
          const Order    = require('./models/Order');
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

          // Shadow order so paid bookings show up in the same revenue/points
          // reporting as product orders (services otherwise never touch Order).
          let loyaltySettings = { loyaltyPointsPerUnit: 100, minPointsPerPurchase: 100 };
          try { loyaltySettings = (await require('./models/Settings').findOne()) || loyaltySettings; } catch (_) {}
          const bookingAmount = pi.amount / 100;
          const bookingPoints = Math.max(loyaltySettings.minPointsPerPurchase, Math.round(bookingAmount * loyaltySettings.loyaltyPointsPerUnit));
          const promotionId = pi.metadata?.promotionId || undefined;
          const campaignMessageId = pi.metadata?.campaignMessageId || undefined;
          const order = await Order.create({
            customer: customer?._id,
            items: [{ productName: serviceName, category: 'Service', quantity: 1, unitPrice: bookingAmount }],
            subtotal: bookingAmount, total: bookingAmount,
            status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), source: promotionId ? 'campaign' : 'booking',
            promotion: promotionId, campaignMessage: campaignMessageId,
            stripePaymentIntentId: pi.id, loyaltyPointsEarned: bookingPoints,
          });
          if (customer) {
            await Customer.findByIdAndUpdate(customer._id, { $inc: { loyaltyPoints: bookingPoints }, $set: { loyaltyPointsUpdatedAt: new Date() } });
          }
          if (campaignMessageId) {
            const cm = await CampaignMessage.findByIdAndUpdate(campaignMessageId, {
              order: order._id, revenue: bookingAmount, pointsIssued: bookingPoints,
            }, { new: true }).catch(() => null);
            if (cm?.flowEnrollment) {
              await FlowEnrollment.findByIdAndUpdate(cm.flowEnrollment, { state: 'completed', order: order._id }).catch(() => {});
            }
          }

          await waPost({ messaging_product: "whatsapp", to: buyerPhone, type: "text",
            text: { body: `✅ *Booking Confirmed!*\n\n📋 ${serviceName}\n📅 ${slotLabel}\n💰 ${money(amountAud, currency)} paid\n\nSee you then! 🎉` },
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
    const promotionId       = pi.metadata?.promotionId || undefined;
    const campaignMessageId = pi.metadata?.campaignMessageId || undefined;
    let loyaltySettings = { loyaltyPointsPerUnit: 100, minPointsPerPurchase: 100 };
    try { loyaltySettings = (await require('./models/Settings').findOne()) || loyaltySettings; } catch (_) {}
    const points = Math.max(loyaltySettings.minPointsPerPurchase, Math.round(subtotal * loyaltySettings.loyaltyPointsPerUnit));

    const cartItems = carts.get(buyerPhone) || [];
    carts.delete(buyerPhone);

    if (buyerPhone) {
      // Persist loyalty points + update/create the order in MongoDB
      try {
        const Customer = require('./models/Customer');
        const Order    = require('./models/Order');
        const customer = await Customer.findOneAndUpdate(
          { phone: buyerPhone },
          { $inc: { loyaltyPoints: points }, $set: { loyaltyPointsUpdatedAt: new Date() } },
          { new: true }
        );

        // The pending Order created at checkout time (proceedToPayment /
        // shared/operations.js#createOrder) is the normal path — update it in
        // place. Fall back to creating one fresh if none is found (e.g. an
        // older in-flight payment from before pending-order creation existed).
        let order = await Order.findOneAndUpdate(
          { stripePaymentIntentId: pi.id },
          { status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), loyaltyPointsEarned: points },
          { new: true },
        );
        if (!order && customer && cartItems.length) {
          order = await Order.create({
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
            paymentStatus:       'paid',
            paidAt:              new Date(),
            source:              promotionId ? 'campaign' : 'product',
            promotion:           promotionId,
            campaignMessage:     campaignMessageId,
            stripePaymentIntentId: pi.id,
            loyaltyPointsEarned: points,
          });
        }
        if (order && campaignMessageId) {
          const cm = await CampaignMessage.findByIdAndUpdate(campaignMessageId, {
            order: order._id, revenue: order.total, pointsIssued: points,
          }, { new: true }).catch(() => null);
          if (cm?.flowEnrollment) {
            await FlowEnrollment.findByIdAndUpdate(cm.flowEnrollment, { state: 'completed', order: order._id }).catch(() => {});
          }
        }
      } catch (err) {
        console.error("MongoDB post-payment update error:", err.message);
      }

      await waPost({
        messaging_product: "whatsapp",
        to: buyerPhone,
        type: "text",
        text: { body: `✅ Payment of ${money(amountAud, currency)} received! Your order is confirmed.\n\n🎁 You've earned *${points} loyalty points*! Thank you for shopping with us! 🎉` },
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
const { sendCatalog, sendProductCarousel, sendVariantPicker, sendPromoAnnouncement, sendServiceSlots } = require("./utils/whatsapp");

async function handlePromoInterest(from, promoId, campaignMessageId) {
  try {
    const Promotion = require("./models/Promotion");
    const Product   = require("./models/Product");

    const promo = await Promotion.findById(promoId).populate("products").populate("services");
    if (!promo) return;

    if (promo.scope === "services") {
      return handleServicePromoInterest(from, promo, campaignMessageId);
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

    pendingCatalogs.set(from, { products, promotion: promo, batchStart: 0, campaignMessageId });
    await sendProductCarousel(from, products, promo, 0);
  } catch (err) {
    console.error("handlePromoInterest error:", err.message);
  }
}

// Tapped "Shop Now" on a Flow-triggered template (win-back, etc.) — there's no
// Promotion involved, just the general active catalog. campaignMessageId still
// threads through pendingCatalogs -> proceedToPayment exactly like a promo send,
// so a resulting order gets attributed back to this CampaignMessage (and from
// there, via its flowEnrollment, back to the flow — see handleStripeWebhook).
async function handleFlowBrowse(from, campaignMessageId) {
  try {
    const Product = require("./models/Product");
    const products = await Product.find({ active: true }).limit(50).lean();
    if (!products.length) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "Sorry, no products are available right now." } });
      return;
    }
    pendingCatalogs.set(from, { products, promotion: null, batchStart: 0, campaignMessageId });
    await sendProductCarousel(from, products, null, 0);
  } catch (err) {
    console.error("handleFlowBrowse error:", err.message);
  }
}

async function handleMoreProducts(from, batchStart, promoId) {
  try {
    const catalog = pendingCatalogs.get(from);
    if (!catalog) return;
    catalog.batchStart = batchStart;
    pendingCatalogs.set(from, catalog);
    await sendProductCarousel(from, catalog.products, catalog.promotion, batchStart);
  } catch (err) {
    console.error("handleMoreProducts error:", err.message);
  }
}

async function handleProductSelection(from, productId, variantLabel) {
  try {
    const catalog = pendingCatalogs.get(from);
    const Product = require("./models/Product");

    let p = catalog?.products.find(x => x._id.toString() === productId);
    if (!p) p = await Product.findById(productId).lean();
    if (!p) return;

    const promo      = catalog?.promotion;
    const isPoints   = promo?.customerType === 'points';

    // If product has variants and no variant chosen yet — show picker
    const availableVariants = (p.variants || []).filter(v => v.stock > 0);
    if (availableVariants.length > 0 && !variantLabel) {
      pendingVariantSelections.set(from, { product: p, promotion: promo });
      await sendVariantPicker(from, p, promo);
      return;
    }

    const discFactor = (!isPoints && promo) ? 1 - promo.discountPercent / 100 : 1;
    const salePrice  = isPoints ? 0 : parseFloat((p.basePrice * discFactor).toFixed(2));
    const pointsCost = isPoints ? (promo?.pointsPrice || 0) : 0;

    const displayName = variantLabel ? `${p.name} (${variantLabel})` : p.name;
    const cart = carts.get(from) || [];
    cart.push({ name: displayName, priceAud: salePrice, pointsCost, description: p.description || p.category || "" });
    carts.set(from, cart);

    let bodyText;
    if (isPoints) {
      const totalPts = cart.reduce((s, i) => s + (i.pointsCost || 0), 0);
      bodyText = `✅ *${displayName}* added!\n💎 ${pointsCost} pts\n\n🛒 Cart: ${cart.length} item${cart.length !== 1 ? "s" : ""} · ${totalPts} pts total\n\n_Keep tapping cards to add more, or checkout when ready._`;
    } else {
      const currency = await getCurrency();
      const total = cart.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
      bodyText = `✅ *${displayName}* added!\n💰 ${money(salePrice, currency)}${promo?.discountPercent ? ` (${promo.discountPercent}% OFF)` : ""}\n\n🛒 Cart: ${cart.length} item${cart.length !== 1 ? "s" : ""} · ${money(total, currency)} total\n\n_Keep tapping cards to add more, or checkout when ready._`;
    }

    await waPost({
      messaging_product: "whatsapp", to: from, type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            { type: "reply", reply: { id: "continue_shopping",                       title: "Keep Browsing 🛍️"  } },
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
async function handleServicePromoInterest(from, promo, campaignMessageId) {
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

    pendingSlotSelections.set(from, { service, promotion: promo, slots, isFree: false, campaignMessageId });
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

      if (pending?.flowEnrollmentId) {
        await FlowEnrollment.findByIdAndUpdate(pending.flowEnrollmentId, { state: 'completed', booking: booking._id }).catch(() => {});
      }

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
      const currency = await getCurrency();
      const amount = service.basePrice || 0;
      const pi = await stripe.paymentIntents.create({
        amount:   Math.round(amount * 100),
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: {
          bookingType: "service",
          buyerPhone:  from,
          serviceId:   service._id.toString(),
          slotId:      slot._id.toString(),
          serviceName: service.name,
          slotLabel:   `${slot.date} at ${slot.startTime}`,
          promotionId:       promotion?._id ? String(promotion._id) : "",
          campaignMessageId: pending?.campaignMessageId ? String(pending.campaignMessageId) : "",
        },
      });

      pendingSlotSelections.delete(from);
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: `📋 *${service.name}*\n📅 ${slot.date} at ${slot.startTime}–${slot.endTime}\n💰 ${money(amount, currency)}\n\nPay securely to confirm your booking:\n${APP_URL}/pay/${pi.id}` } });

      // Second option — hold the slot without paying online; the merchant reviews and confirms.
      pendingPayLaterSlots.set(from, { service, slot });
      await waPost({
        messaging_product: "whatsapp", to: from, type: "interactive",
        interactive: {
          type:   "button",
          body:   { text: "Prefer to pay when you arrive?" },
          action: { buttons: [{ type: "reply", reply: { id: `paylater_${slot._id}`, title: "Reserve, Pay in Person" } }] },
        },
      }).catch(err => console.error("pay-later offer error:", err.message));
    }
  } catch (err) {
    console.error("handleSlotSelection error:", err.message);
  }
}

async function handlePayLaterReservation(from, slotId) {
  try {
    const pending = pendingPayLaterSlots.get(from);
    if (!pending || pending.slot._id.toString() !== slotId) return;
    pendingPayLaterSlots.delete(from);

    const TimeSlot = require("./models/TimeSlot");
    const Customer = require("./models/Customer");
    const Booking  = require("./models/Booking");

    const { service, slot } = pending;
    const freshSlot = await TimeSlot.findById(slot._id);
    if (!freshSlot || freshSlot.bookedCount >= freshSlot.capacity) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "⚠️ Sorry, that slot just got booked up. Please pick another time." } });
      return;
    }

    await TimeSlot.findByIdAndUpdate(slot._id, { $inc: { bookedCount: 1 } });
    const customer = await Customer.findOne({ phone: from });
    await Booking.create({
      serviceId:    service._id,
      slotId:       slot._id,
      customerId:   customer?._id,
      phone:        from,
      customerName: customer ? `${customer.firstname || ''} ${customer.lastname || ''}`.trim() : from,
      status:       'requested',
      paymentType:  'pay_later',
      amount:       service.basePrice || 0,
    });

    await waPost({ messaging_product: "whatsapp", to: from, type: "text",
      text: { body: `📝 *Reservation Requested!*\n\n📋 ${service.name}\n📅 ${slot.date} at ${slot.startTime}\n\nWe'll confirm your slot shortly. Pay in person on the day.` } });
  } catch (err) {
    console.error("handlePayLaterReservation error:", err.message);
  }
}

// Shows available slots for a rebook (free, initiated from a cancellation or
// no-show WA message). flowEnrollmentId is only set for the no-show flow —
// threaded through to pendingSlotSelections so handleSlotSelection can mark
// that FlowEnrollment 'completed' once the customer actually rebooks (this
// converts via a new Booking, not an Order, so the generic Stripe-webhook
// completion hook used by the other flow triggers doesn't cover it).
async function handleRebookRequest(from, serviceId, oldBookingId, flowEnrollmentId) {
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

    pendingSlotSelections.set(from, { service, promotion: null, slots, isFree: true, oldBookingId, flowEnrollmentId });
    await sendServiceSlots(from, service, slots, null, true);
  } catch (err) {
    console.error("handleRebookRequest error:", err.message);
  }
}

// ─── WhatsApp incoming messages ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;

  // Delivery/read/failed callbacks for outbound messages — no inbound message here.
  if (value?.statuses?.length) {
    await handleStatusCallbacks(value.statuses);
    return;
  }

  const message = value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  console.log(`Incoming from ${from}:`, JSON.stringify(message, null, 2));

  // ── Template quick-reply (user tapped button on a template message) ──────────
  if (message.type === "button") {
    const payload = message.button?.payload || "";
    if (payload.startsWith("promo_")) {
      const promoId = payload.slice(6);
      const cm = await correlateClick({ from, wamid: message.context?.id, promotionId: promoId });
      await handlePromoInterest(from, promoId, cm?._id);
    } else if (payload.startsWith("flowbrowse_")) {
      const cm = await correlateClick({ from, wamid: message.context?.id });
      await handleFlowBrowse(from, cm?._id);
    } else if (payload.startsWith("flownoshow_")) {
      const parts     = payload.slice(11).split("_");
      const serviceId = parts[0];
      const bookingId = parts[1];
      const cm = await correlateClick({ from, wamid: message.context?.id });
      await handleRebookRequest(from, serviceId, bookingId, cm?.flowEnrollment);
    } else if (payload.startsWith("msgnode_")) {
      // Entry-node tap — always arrives here since the entry message is always
      // a template (see models/MessageNode.js).
      const parts = payload.slice(8).split("_");
      await handleMessageNodeTap({ from, wamid: message.context?.id, nodeId: parts[0], position: +parts[1] });
    }
    return;
  }

  // ── Interactive messages ──────────────────────────────────────────────────────
  if (message.type === "interactive") {

    // List message row tapped
    if (message.interactive.type === "list_reply") {
      const rowId = message.interactive.list_reply?.id || "";
      if (rowId.startsWith("variant_")) {
        // Customer picked a size/colour variant
        const parts     = rowId.slice(8).split("_");
        const productId = parts[0];
        const varIdx    = parts[1]; // numeric index or "base"
        const pending   = pendingVariantSelections.get(from);
        pendingVariantSelections.delete(from);
        if (pending) {
          const product = pending.product;
          let label = "";
          if (varIdx !== "base") {
            const v = (product.variants || [])[parseInt(varIdx, 10)];
            label = [v?.size, v?.color].filter(Boolean).join(" · ");
          }
          await handleProductSelection(from, productId, label);
        }
      } else if (rowId.startsWith("slot_")) {
        await handleSlotSelection(from, rowId.slice(5), false, null);
      } else if (rowId.startsWith("reslot_")) {
        const pending = pendingSlotSelections.get(from);
        await handleSlotSelection(from, rowId.slice(7), true, pending?.oldBookingId || null);
      } else if (rowId.startsWith("cart_")) {
        // Product row from list fallback
        await handleProductSelection(from, rowId.slice(5), "");
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

      } else if (buttonId.startsWith("paylater_")) {
        // Customer tapped "Reserve, Pay in Person" instead of the Stripe link
        await handlePayLaterReservation(from, buttonId.slice(9));

      } else if (buttonId.startsWith("promo_")) {
        // "Shop Now" / "Book Now" tapped on promo message → show catalog or slots
        const promoId = buttonId.slice(6);
        const cm = await correlateClick({ from, wamid: message.context?.id, promotionId: promoId });
        await handlePromoInterest(from, promoId, cm?._id);

      } else if (buttonId.startsWith("msgnode_")) {
        // Deeper-node tap — always arrives here since follow-up MessageNodes
        // are always sent free-form (see models/MessageNode.js).
        const parts = buttonId.slice(8).split("_");
        await handleMessageNodeTap({ from, wamid: message.context?.id, nodeId: parts[0], position: +parts[1] });

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

      } else if (buttonId.startsWith("cart_")) {
        // "Add to Cart" tapped on an individual product card (button_reply from sendProductCards)
        await handleProductSelection(from, buttonId.slice(5), "");

      } else if (buttonId.startsWith("more_")) {
        // Load next carousel batch: more_<batchStart>_<promoId>
        const parts      = buttonId.slice(5).split("_");
        const batchStart = parseInt(parts[0], 10);
        const promoId    = parts.slice(1).join("_");
        await handleMoreProducts(from, batchStart, promoId);

      } else if (buttonId === "continue_shopping" || buttonId === "shop_now") {
        const catalog = pendingCatalogs.get(from);
        if (catalog) {
          await sendProductCarousel(from, catalog.products, catalog.promotion, catalog.batchStart || 0)
            .catch(err => console.error("continue_shopping carousel error:", err.message));
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
        if (customer.address) {
          await proceedToPointsConfirmation(from, customer, cart);
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
    const upperText = text.toUpperCase();

    // Opt-out / opt-back-in — checked first, ahead of any pending flow, per
    // the "Reply STOP to unsubscribe" promise already in the promo template footer.
    if (upperText === "STOP" || upperText === "UNSUBSCRIBE") {
      const Customer = require("./models/Customer");
      await Customer.findOneAndUpdate({ phone: from }, { optedOut: true, optedOutAt: new Date() });
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "You've been unsubscribed from promotional messages. Reply START to opt back in anytime." } }).catch(() => {});
      return;
    }
    if (upperText === "START" || upperText === "SUBSCRIBE") {
      const Customer = require("./models/Customer");
      await Customer.findOneAndUpdate({ phone: from }, { optedOut: false, optedOutAt: null });
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "You're subscribed to promotional messages again. Welcome back! 🎉" } }).catch(() => {});
      return;
    }

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
            { $inc: { loyaltyPoints: -pending.totalPointsCost }, $set: { loyaltyPointsUpdatedAt: new Date() } },
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
            { $inc: { loyaltyPoints: -pending.totalPointsCost }, $set: { loyaltyPointsUpdatedAt: new Date() } },
            { new: true }
          );
          if (!customer) {
            await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
              text: { body: '⚠️ Insufficient points. Your order could not be processed.' } }).catch(() => {});
            return;
          }
          if (pending.cart.length) {
            const order = await Order.create({
              customer:         customer._id,
              items:            pending.cart.map(i => ({ productName: i.name, category: i.description || 'General', quantity: 1, unitPrice: 0 })),
              subtotal:         0,
              shippingCost:     0,
              shippingAddress:  pending.address,
              total:            0,
              loyaltyPointsUsed:  pending.totalPointsCost,
              loyaltyDiscount:    pending.totalPointsCost,
              status:           'confirmed',
              paymentStatus:    'paid',
              paidAt:           new Date(),
              source:           pending.promotion ? 'campaign' : 'product',
              promotion:        pending.promotion?._id,
              campaignMessage:  pending.campaignMessageId,
              loyaltyPointsEarned: 0,
            });
            if (pending.campaignMessageId) {
              await CampaignMessage.findByIdAndUpdate(pending.campaignMessageId, { order: order._id }).catch(() => {});
            }
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
        await proceedToPointsConfirmation(from, customer, cart);
      } else {
        await proceedToPayment(from, customer, cart);
      }
      return;
    }

    // Number selection from a large catalog text list (fallback when carousel unsupported)
    const catalog = pendingCatalogs.get(from);
    if (!catalog) return;

    const products = catalog.products;
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

    // Route each selection through handleProductSelection (handles variant check too)
    for (const i of indices) {
      await handleProductSelection(from, products[i]._id.toString(), "");
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

app.get("/", (req, res) => res.send("Waflow backend running"));

// Guarded so tests can `require('./server')` for its exported `app` (Supertest)
// without also binding a port or kicking off the WA token refresh.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    tokenManager.init(); // validate + auto-refresh WA token in background
    require("./utils/flowScheduler").startFlowScheduler();
  });
}

module.exports = app;
