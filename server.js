require("dotenv").config();
const tokenManager = require("./utils/tokenManager");
const express  = require("express");
const cors     = require("cors");
const Stripe   = require("stripe");
const mongoose = require("mongoose");
const helmet   = require("helmet");

const { PORT, APP_URL } = require("./utils/config");
const senderContext = require("./utils/senderContext"); // which customer (workspace) a WhatsApp job is for — see utils/senderContext.js
const whatsappInbound = require("./shared/whatsappInbound"); // per-event workspace resolution for the webhook
const metaSignature = require("./shared/onboarding/webhookSignature"); // X-Hub-Signature-256 helpers
const { carts, pendingCatalogs, pendingAddressReqs, pendingPointsCheckouts, pendingSlotSelections, pendingServiceCheckouts, pendingVariantSelections, pendingPayLaterSlots } = require("./utils/state");
const { money } = require("./utils/currency");
const { getCurrency } = require("./utils/settingsCache");
const CampaignMessage = require("./models/CampaignMessage");
const FlowEnrollment  = require("./models/FlowEnrollment");
const MessageNode     = require("./models/MessageNode");
const Workspace       = require("./models/Workspace");
const { requireAuth } = require("./middleware/requireAuth");
const sanitizeBody = require("./middleware/sanitizeBody"); // drops workspaceId/_id/isDemo from bodies, refuses "$operator" keys — see the file
const { withWorkspace, scopedFilter } = require("./shared/operations");
const inbox            = require("./shared/inbox"); // WhatsApp Inbox — see shared/inbox.js
const referrals         = require("./shared/referrals"); // Referral Promotions — see shared/referrals.js
const instagram         = require("./shared/instagram"); // Instagram Promotion Scheduler — see shared/instagram.js
const localization      = require("./shared/localization"); // Arabic localisation — see shared/localization/index.js
const envFlag           = require("./utils/envFlag"); // on/off settings read from the environment, a value that is not understood is reported

// The WhatsApp webhook and Stripe webhook serve real customers directly, with
// no logged-in session to read a workspaceId from. The OLDEST workspace (the
// one scripts/migrate-to-workspace.js created) is the answer for everything
// that cannot be attributed to a customer (tenant) — resolve it fresh per
// webhook call rather than caching, since correctness matters more than one
// indexed query. Each WhatsApp EVENT is attributed to its own workspace first
// (customer's own phone number, wamid, payload id, phone — see
// shared/whatsappInbound.js) and Stripe payments by pi.metadata.workspaceId;
// this oldest-workspace lookup is the fallback for both.
async function resolveWebhookWorkspaceId() {
  const workspace = await Workspace.findOne().sort({ createdAt: 1 });
  return workspace?._id;
}

const app  = express();
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_verify_token";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/waflow";

// Stripe webhook needs raw body — before express.json()
app.post("/stripe-webhook", express.raw({ type: "application/json" }), handleStripeWebhook);
try { require("./shared/onboarding/earlyMounts").mount(app, express); } catch (err) { console.error("[onboarding] early mounts not installed:", err.message); }

// POST /webhook: the exact bytes Meta signed are captured while express.json() parses the body (req.rawBody), and
// X-Hub-Signature-256 is checked against them (req.metaSignature = 'valid' | 'invalid' | 'missing' | 'unconfigured').
//   WEBHOOK_SIGNATURE_MODE  off     not checked ('unconfigured')
//                           log     (default) checked, an invalid/missing one is logged, never rejected
//                           enforce an invalid/missing one is answered 401 BEFORE the 200 — only when WA_APP_SECRET is set
// Every other route is parsed exactly as before (the callback does nothing for them).
// The decision to refuse does not rest on this callback alone: the route itself runs webhookSignatureGate (below), which refuses
// anything whose signature was not positively checked as valid - another capitalisation of the path (Express matches routes
// case-insensitively), a form-encoded or text body that express.json() never reads, a request the callback never saw.
function webhookSignatureMode() {
  const v = String(process.env.WEBHOOK_SIGNATURE_MODE || "").trim().toLowerCase();
  return v === "off" || v === "enforce" ? v : "log";
}
// trimmed: a newline or space pasted along with the secret into the hosting settings would otherwise make every signature "invalid"
function webhookAppSecret() {
  return process.env.WA_APP_SECRET ? String(process.env.WA_APP_SECRET).trim() : "";
}
let lastSignatureLogAt = 0;
function captureWebhookSignature(req, res, buf) {
  if (req.method !== "POST") return;
  const path = String(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  if (path !== "/webhook") return;
  req.rawBody = buf;
  const mode = webhookSignatureMode();
  const secret = webhookAppSecret();
  let state = "unconfigured";
  if (mode !== "off" && secret) {
    let header = req.headers["x-hub-signature-256"];
    if (Array.isArray(header)) header = header[0];
    state = typeof header !== "string" || !header.trim() ? "missing" : (metaSignature.verify(buf, header, secret) ? "valid" : "invalid");
  }
  req.metaSignature = state;
  if (state !== "invalid" && state !== "missing") return;
  if (mode === "enforce") {
    const err = new Error("Invalid webhook signature");
    err.status = 401; err.statusCode = 401; err.type = "webhook.signature";
    throw err; // express.json() hands this to the error handler below: 401, nothing processed
  }
  const now = Date.now();
  if (now - lastSignatureLogAt > 60 * 1000) { // log mode: say so (at most once a minute), never reject
    lastSignatureLogAt = now;
    console.warn(`[webhook] X-Hub-Signature-256 ${state} (WEBHOOK_SIGNATURE_MODE=log: accepted)`);
  }
}
app.use(express.json({ verify: captureWebhookSignature }));
app.use((err, req, res, next) => {
  if (err && err.type === "webhook.signature") return res.status(401).json({ error: "Invalid signature" });
  return next(err);
});
if (webhookSignatureMode() === "enforce" && !webhookAppSecret()) {
  console.warn("[startup] WEBHOOK_SIGNATURE_MODE=enforce but WA_APP_SECRET is not set: webhook signatures are NOT being checked.");
}
// A typo in a setting that is a safety net must not pass silently: a value that is not understood gets the default (for the sign-up
// switch it counts as OFF: a typo must not leave sign-up open) - say so once.
envFlag.warnUnknown([{ name: "ALLOW_SELF_SERVE_SIGNUP", treatedAs: "off" }, "CONSENT_REQUIRE_SIGNATURE", "PROMO_ENTRY_FALLBACK", "TEMPLATE_APPROVAL_SWEEP", "WEBHOOK_LOG_BODIES"]);
if (process.env.WEBHOOK_SIGNATURE_MODE && !["off", "log", "enforce"].includes(String(process.env.WEBHOOK_SIGNATURE_MODE).trim().toLowerCase())) {
  console.warn(`[startup] WEBHOOK_SIGNATURE_MODE="${String(process.env.WEBHOOK_SIGNATURE_MODE).slice(0, 20)}" is not understood (use off, log or enforce): "log" is used.`);
}
{
  // CONSENT_REQUIRE_SIGNATURE on with no way to verify a signature would refuse every opt-in: say so at start-up, not only per tap.
  const consentSetupProblem = require("./shared/consent").signatureSetupProblem({ secretConfigured: !!webhookAppSecret(), mode: webhookSignatureMode() });
  if (consentSetupProblem) console.warn(`[startup] ${consentSetupProblem}`);
}
// Who may open the Platform area (a count only: never the contacts). A value with a typo is reported by the parser itself, masked.
try {
  const admins = require("./shared/platformAdmin").parseSuperAdminContacts();
  const count = admins.emails.size + admins.phones.size;
  console.log(`[startup] platform super admins configured: ${count}${count ? "" : " (SUPER_ADMIN_CONTACTS is empty: the Platform area is closed to everyone)"}`);
} catch (err) { console.warn("[startup] SUPER_ADMIN_CONTACTS could not be read:", err && err.message); }
// The route-level check behind WEBHOOK_SIGNATURE_MODE=enforce (only with WA_APP_SECRET set): the request must have been positively
// verified. Read per request, like the mode. 401 BEFORE the route's 200, so nothing is processed.
function webhookSignatureGate(req, res, next) {
  if (webhookSignatureMode() !== "enforce" || !webhookAppSecret()) return next();
  if (req.metaSignature === "valid") return next();
  return res.status(401).json({ error: "Invalid signature" });
}
app.use(express.urlencoded({ extended: true })); // OAuth token/authorize endpoints use form-encoded bodies
app.use(cors());
// Cheap, real HTTP header hardening (HSTS, X-Content-Type-Options, etc.) —
// contentSecurityPolicy off because the MCP OAuth login page and the new
// /internal-admin pages use inline <style>/onsubmit, and building a correct
// policy for those two hand-rolled pages is out of scope here.
// crossOriginResourcePolicy off because the dashboard (a different origin)
// loads product/service images directly from /uploads/*.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// ─── MongoDB ─────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err.message));
// Warn (not fail) at boot if the connection string looks like it drops TLS —
// Cosmos DB for MongoDB connection strings already include tls=true, this is
// a sanity check against a misconfigured/copied-wrong MONGODB_URI, not a new
// encryption mechanism (see the Data Protection Compliance plan's §8).
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(MONGODB_URI) && !/[?&](tls|ssl)=true/i.test(MONGODB_URI)) {
  console.warn("[startup] MONGODB_URI does not appear to enforce TLS (no tls=true/ssl=true) and isn't localhost — double-check the connection string.");
}

try { require("./shared/onboarding/mount").mount(app, { requireAuth, requireInternalAdmin: require("./middleware/requireInternalAdmin") }); } catch (err) { console.error("[onboarding] routes not mounted:", err.message); }
// ─── Auth (passwordless login) — must stay public ───────────────────────────
app.use("/api/auth", require("./routes/auth"));

// ─── API routes — everything below requires a logged-in session ────────────
// (sanitizeBody: a write never carries workspaceId / _id / isDemo or a "$operator" key from the client — several of these routes
// hand req.body straight to findOneAndUpdate.)
app.use("/api/products",   requireAuth, sanitizeBody, require("./routes/products"));
app.use("/api/customers",  requireAuth, sanitizeBody, require("./routes/customers"));
app.use("/api/orders",     requireAuth, sanitizeBody, require("./routes/orders"));
app.use("/api/promotions", requireAuth, sanitizeBody, require("./routes/promotions"));
app.use("/api/flows",      requireAuth, sanitizeBody, require("./routes/flows"));
app.use("/api/message-nodes", requireAuth, sanitizeBody, require("./routes/messageNodes"));
app.use("/api/services",   requireAuth, sanitizeBody, require("./routes/services"));
app.use("/api/whatsapp",   requireAuth, sanitizeBody, require("./routes/whatsapp"));
app.use("/api/settings",  requireAuth, sanitizeBody, require("./routes/settings"));
app.use("/api/ai-chat",   requireAuth, require("./routes/aiChat"));
app.use("/api/uploads",   requireAuth, require("./routes/uploads"));
app.use("/api/workspaces", requireAuth, sanitizeBody, require("./routes/workspaces"));
app.use("/api/support",    requireAuth, require("./routes/support"));
app.use("/api/imports",    requireAuth, require("./routes/imports"));
app.use("/api/inbox",      requireAuth, sanitizeBody, require("./routes/inbox"));
app.use("/api/insights",   requireAuth, sanitizeBody, require("./routes/insights"));
app.use("/api/entitlements", requireAuth, sanitizeBody, require("./routes/entitlements"));
app.use("/api/legal",      requireAuth, require("./routes/legal"));
app.use("/api/referrals",  requireAuth, sanitizeBody, require("./routes/referrals"));
app.use("/api/instagram-posts", requireAuth, sanitizeBody, require("./routes/instagramPosts"));
app.use("/api/instagram-media", requireAuth, require("./routes/instagramMedia"));
app.use("/api/social-accounts",  requireAuth, sanitizeBody, require("./routes/socialAccounts"));
// WaFlow staff (super admins) onboard and manage customers (tenants) here — see routes/platform.js. 403 for everyone else.
try { app.use("/api/platform", requireAuth, require("./middleware/requireSuperAdmin"), require("./routes/platform")); }
catch (err) { console.error("[platform] routes not mounted:", err.message); }
// Arabic localisation (all new files). Every route except /settings is also gated
// by the per-merchant arabic_enabled flag — see routes/localization/index.js. A
// failure to load this feature must never stop the existing app from starting.
try { app.use("/api/localization", requireAuth, require("./routes/localization")); }
catch (err) { console.error("[localization] API routes not mounted:", err.message); }
// Uploaded images must stay public — WhatsApp's own servers fetch them by URL
// with no Authorization header when rendering a message to a real customer.
app.use("/uploads", express.static(require("./utils/config").UPLOAD_DIR));
// Arabic customer pages (payment / referral / Instagram link) — fall through with
// next() to the existing English handlers below unless the merchant has Arabic
// enabled AND the visitor's language is Arabic (see routes/localization/pages.js).
try { app.use(require("./routes/localization/pages")); }
catch (err) { console.error("[localization] customer pages not mounted:", err.message); }
app.use(require("./routes/pay"));
// Public referral-link redirects (/r/:code, /c/:code) — a friend's browser
// hits these directly, with no logged-in session.
app.use(require("./routes/referralRedirect"));
// Public Instagram tracking redirects (/t/:code) and the Meta OAuth callback
// (Meta redirects the merchant's bare browser here, no session available).
app.use(require("./routes/instagramRedirect"));

// ─── MCP (Model Context Protocol) — lets Claude connect as tools ────────────
app.use(require("./mcp/oauth").router);
app.use("/mcp", require("./mcp"));

// ─── ChatGPT Custom GPT Actions — REST + OpenAPI, separate API-key auth ─────
app.use("/gpt-api", require("./gpt/routes"));

// ─── Internal admin (Data Protection Compliance) — Waflow-staff-only PII
// deletion/correction tooling, separate credential from both the merchant
// JWT auth above and the MCP admin login ─────────────────────────────────────
app.use("/internal-admin", require("./middleware/requireInternalAdmin"), require("./routes/internalAdmin"));
// Entitlements/billing admin tool — same Basic Auth gate, separate path
// prefix so mounting it here doesn't touch the router above.
app.use("/internal-admin-billing", require("./middleware/requireInternalAdmin"), require("./routes/adminEntitlements"));
// Instagram Promotion Scheduler add-on toggle — same pattern.
app.use("/internal-admin-instagram", require("./middleware/requireInternalAdmin"), require("./routes/adminInstagram"));
// Arabic localisation rollout flag + string-review counts — same pattern.
try { app.use("/internal-admin-localization", require("./middleware/requireInternalAdmin"), require("./routes/adminLocalization")); }
catch (err) { console.error("[localization] admin page not mounted:", err.message); }

// ─── Stripe ──────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_SIGNING_SECRET = process.env.STRIPE_SIGNING_SECRET;

// ─── WhatsApp helpers ────────────────────────────────────────────────────────
// ONE sender: the same function every other part of the app uses (utils/whatsapp.js — Arabic localisation hook, the
// customer's own phone number when the workspace in context has one, platform number otherwise). This file used to
// carry its own copy that always used the platform number and token.
function waPost(body) {
  return require("./utils/whatsapp").waPost(body);
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

// ─── In-memory state ─────────────────────────────────────────────────────────
// carts / pendingCatalogs / pendingAddressReqs live in ./utils/state (shared with routes/pay.js)
const pendingProducts = new Map(); // randomId → { name, priceAud, description } (legacy "int_" button; nothing fills it since POST /send-message was removed)

// ─── Campaign message tracking (delivery status + click correlation) ────────
// Rank for monotonic status updates — never let an out-of-order webhook event
// downgrade an already-more-advanced status (e.g. a late "sent" arriving after
// "read" already landed).
const STATUS_RANK = { queued: 0, sent: 1, failed: 1, delivered: 2, read: 3 };

async function handleStatusCallbacks(statuses, workspaceId) {
  for (const s of statuses) {
    try {
      const cm = await CampaignMessage.findOne(withWorkspace({ wamid: s.id }, workspaceId));
      if (!cm) continue;
      if ((STATUS_RANK[s.status] ?? 0) < (STATUS_RANK[cm.status] ?? 0)) continue;

      const update = { status: s.status };
      const ts = s.timestamp ? new Date(+s.timestamp * 1000) : new Date();
      if (s.status === "sent")      update.sentAt = ts;
      if (s.status === "delivered") update.deliveredAt = ts;
      if (s.status === "read")      update.readAt = ts;
      if (s.status === "failed")    update.statusReason = s.errors?.[0]?.title || s.errors?.[0]?.message;
      if (s.status === "failed" && s.errors?.[0]?.code != null) update.errorCode = String(s.errors[0].code).slice(0, 20); // C3: Meta error code

      await CampaignMessage.findByIdAndUpdate(cm._id, update);
    } catch (err) {
      console.error("handleStatusCallbacks error:", err.message);
    }

    // Same delivery/read ticks, for a manual WhatsApp Inbox send instead of a
    // campaign one — see shared/inbox.js#updateMessageStatus. No-ops if `s.id`
    // isn't a manual send's wamid (the common case for every other status).
    await inbox.updateMessageStatus(s, workspaceId).catch(err => console.error("inbox updateMessageStatus error:", err.message));
  }
}

// Correlates an inbound button tap back to the CampaignMessage that prompted it —
// precise match via the wamid in `context.id` (the message being replied to), with
// a (promotion, customer, most-recent-sent) fallback if context is unavailable.
async function correlateClick({ from, wamid, promotionId, workspaceId }) {
  try {
    let cm = null;
    if (wamid) {
      cm = await CampaignMessage.findOneAndUpdate(withWorkspace({ wamid }, workspaceId), { clickedAt: new Date() }, { new: true });
    }
    if (!cm && promotionId) {
      const Customer = require("./models/Customer");
      const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
      if (customer) {
        cm = await CampaignMessage.findOneAndUpdate(
          withWorkspace({ promotion: promotionId, customer: customer._id, status: { $in: ["sent", "delivered", "read"] } }, workspaceId),
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
async function handleMessageNodeTap({ from, wamid, nodeId, position, workspaceId }) {
  try {
    if (!wamid) return;
    const claimed = await CampaignMessage.findOneAndUpdate(
      withWorkspace({ wamid, respondedAt: null }, workspaceId),
      { $set: { clickedAt: new Date(), respondedAt: new Date(), clickedButtonPosition: position } },
      { new: true },
    );
    if (!claimed) return; // already handled

    const node = await MessageNode.findOne(scopedFilter(nodeId, workspaceId));
    const button = node?.buttons.find(b => b.position === position);
    if (!button) return;

    const { type, targetNodeId } = button.nextAction;

    if (type === "send_message" && targetNodeId) {
      const targetNode = await MessageNode.findOne(scopedFilter(targetNodeId, workspaceId));
      if (!targetNode) return;

      const Customer = require("./models/Customer");
      const customer = await Customer.findOne(scopedFilter(claimed.customer, workspaceId));
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
        // Arabic localisation: a reviewed Arabic version of THIS follow-up for an Arabic-speaking customer of a flagged workspace; null = the unchanged English send. Fail-open.
        let localizedFollowUp = null;
        try { localizedFollowUp = await require("./shared/localization/followUpSender").sendLocalizedFollowUp({ workspaceId, to: from, node: targetNode, customer, enrollmentId: claimed.flowEnrollment }); } catch (_) { localizedFollowUp = null; }
        if (localizedFollowUp && localizedFollowUp.error) throw localizedFollowUp.error; // recorded as failed below; never re-sent in English
        const result = localizedFollowUp ? localizedFollowUp.result : await sendMessageNodeFollowUp(from, targetNode, [customer.firstname || "there"]);
        followUpWamid = result?.messages?.[0]?.id;
      } catch (err) {
        sendStatus = "failed";
        statusReason = err.message;
      }
      // Inherits kind/flow/flowEnrollment/promotion from whichever CampaignMessage
      // this tap resolved (DEFECT-02: entry sends now come from a Promotion just
      // as often as a Flow) — hardcoding kind:"flow" here would mis-attribute
      // every promotion-sourced follow-up.
      await CampaignMessage.create({
        kind: claimed.kind, flow: claimed.flow, flowEnrollment: claimed.flowEnrollment, promotion: claimed.promotion,
        customer: customer._id, phone: from, workspaceId,
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
        kind: claimed.kind, flow: claimed.flow, flowEnrollment: claimed.flowEnrollment, promotion: claimed.promotion,
        customer: claimed.customer, phone: from, workspaceId,
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

async function createPaymentIntent(buyerPhone, cart, shippingCost, subtotal, address, currency, promotionId, campaignMessageId, workspaceId) {
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
      ...(workspaceId ? { workspaceId: String(workspaceId) } : {}), // the Stripe webhook resolves the customer (tenant) from this
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
    const pi = await createPaymentIntent(from, cart, SHIPPING_COST, subtotal, customer.address, currency, promotion?._id, campaignMessageId, customer.workspaceId);

    // Visible in the dashboard immediately as pending — the Stripe webhook updates
    // this same document (matched by stripePaymentIntentId) to paid/failed.
    const Order = require("./models/Order");
    await Order.create({
      customer: customer._id, workspaceId: customer.workspaceId,
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
  pendingPointsCheckouts.set(from, { cart, promotion, campaignMessageId, totalPointsCost, address: customer.address, workspaceId: customer.workspaceId });
  const itemList  = cart.map(i => `• ${i.name}`).join("\n");
  const remaining = customer.loyaltyPoints - totalPointsCost;
  await waPost({
    messaging_product: "whatsapp", to: from, type: "text",
    text: { body: `💎 *Points Redemption Summary*\n\n${itemList}\n\n📍 Delivering to: ${customer.address}\n\n*${totalPointsCost} points will be deducted*\nYou have: ${customer.loyaltyPoints} pts → after: ${remaining} pts\n\nReply *YES* to confirm or *NO* to cancel.` },
  }).catch(() => {});
}

// ─── Stripe webhook ──────────────────────────────────────────────────────────
// The customer (tenant) a payment belongs to: the workspaceId written into the PaymentIntent metadata when it was created,
// else (payments created before that, or by a creation site that does not write it yet) the oldest workspace, as before.
async function resolveStripeWorkspaceId(pi) {
  const fromMetadata = pi && pi.metadata && pi.metadata.workspaceId;
  if (typeof fromMetadata === "string" && /^[0-9a-fA-F]{24}$/.test(fromMetadata)) {
    try {
      const workspace = await Workspace.findById(fromMetadata).select("_id");
      if (workspace) return workspace._id;
    } catch (_) { /* fall back to the oldest workspace */ }
  }
  return resolveWebhookWorkspaceId();
}

async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_SIGNING_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const workspaceId = await resolveStripeWorkspaceId(event.data && event.data.object);
  senderContext.enter(workspaceId); // the payment confirmations below go out from this customer's WhatsApp number
  localization.enterContext(workspaceId); // Arabic localisation: same scoping for the payment confirmations sent from here (never throws)

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    const Order = require('./models/Order');
    await Order.findOneAndUpdate(withWorkspace({ stripePaymentIntentId: pi.id }, workspaceId), { paymentStatus: 'failed' }).catch(() => {});
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
          const customer = await Customer.findOne(withWorkspace({ phone: buyerPhone }, workspaceId));
          await TimeSlot.findOneAndUpdate(scopedFilter(slotId, workspaceId), { $inc: { bookedCount: 1 } });
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
            workspaceId: customer?.workspaceId || workspaceId,
          });

          // Shadow order so paid bookings show up in the same revenue/points
          // reporting as product orders (services otherwise never touch Order).
          let loyaltySettings = { loyaltyPointsPerUnit: 100, minPointsPerPurchase: 100 };
          try { loyaltySettings = (await require('./models/Settings').findOne(withWorkspace({}, workspaceId))) || loyaltySettings; } catch (_) {}
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
            workspaceId: customer?.workspaceId || workspaceId,
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

          const bookingConfirmedBody = `✅ *Booking Confirmed!*\n\n📋 ${serviceName}\n📅 ${slotLabel}\n💰 ${money(amountAud, currency)} paid\n\nSee you then! 🎉`;
          if (customer) {
            const { sendUtilityMessageWithConsentAsk } = require('./shared/consent');
            await sendUtilityMessageWithConsentAsk({ customer, workspaceId, body: bookingConfirmedBody })
              .catch(err => console.error("Service booking WA error:", err.message));
          } else {
            await waPost({ messaging_product: "whatsapp", to: buyerPhone, type: "text", text: { body: bookingConfirmedBody } })
              .catch(err => console.error("Service booking WA error:", err.message));
          }
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
    try { loyaltySettings = (await require('./models/Settings').findOne(withWorkspace({}, workspaceId))) || loyaltySettings; } catch (_) {}
    const points = Math.max(loyaltySettings.minPointsPerPurchase, Math.round(subtotal * loyaltySettings.loyaltyPointsPerUnit));

    const cartItems = carts.get(buyerPhone) || [];
    carts.delete(buyerPhone);

    let customer = null;
    if (buyerPhone) {
      // Persist loyalty points + update/create the order in MongoDB
      try {
        const Customer = require('./models/Customer');
        const Order    = require('./models/Order');
        customer = await Customer.findOneAndUpdate(
          withWorkspace({ phone: buyerPhone }, workspaceId),
          { $inc: { loyaltyPoints: points }, $set: { loyaltyPointsUpdatedAt: new Date() } },
          { new: true }
        );

        // The pending Order created at checkout time (proceedToPayment /
        // shared/operations.js#createOrder) is the normal path — update it in
        // place. Fall back to creating one fresh if none is found (e.g. an
        // older in-flight payment from before pending-order creation existed).
        let order = await Order.findOneAndUpdate(
          withWorkspace({ stripePaymentIntentId: pi.id }, workspaceId),
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
            workspaceId: customer?.workspaceId || workspaceId,
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

      const paymentConfirmedBody = `✅ Payment of ${money(amountAud, currency)} received! Your order is confirmed.\n\n🎁 You've earned *${points} loyalty points*! Thank you for shopping with us! 🎉`;
      if (customer) {
        const { sendUtilityMessageWithConsentAsk } = require('./shared/consent');
        await sendUtilityMessageWithConsentAsk({ customer, workspaceId, body: paymentConfirmedBody })
          .catch(err => console.error("Payment confirmation error:", err.message));
      } else {
        await waPost({ messaging_product: "whatsapp", to: buyerPhone, type: "text", text: { body: paymentConfirmedBody } })
          .catch(err => console.error("Payment confirmation error:", err.message));
      }
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

// A tap on a consent-request button (payload promo:<promotionId>:<action>:<position>): shared/promoConsentTap.js records
// the consent evidence and answers; it reaches the shop/book flow below only through deps. Never throws.
async function handlePromoConsentTapSafe({ from, message, signature, workspaceId }) {
  try {
    const { handlePromoConsentTap } = require("./shared/promoConsentTap");
    await handlePromoConsentTap({
      from, message, signature, workspaceId,
      deps: {
        handlePromoInterest,
        waPost,
        sendText: (to, body) => waPost({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
      },
    });
  } catch (err) {
    console.error("promo consent tap error:", err && err.message);
  }
}

async function handlePromoInterest(from, promoId, campaignMessageId, workspaceId) {
  try {
    const Promotion = require("./models/Promotion");
    const Product   = require("./models/Product");

    const promo = await Promotion.findOne(scopedFilter(promoId, workspaceId)).populate("products").populate("services");
    if (!promo) return;

    if (promo.scope === "services") {
      return handleServicePromoInterest(from, promo, campaignMessageId, workspaceId);
    }

    let products = promo.products || [];
    if (!products.length && promo.type === "store_wide") {
      products = await Product.find(withWorkspace({ active: true }, workspaceId)).limit(50).lean();
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
async function handleFlowBrowse(from, campaignMessageId, workspaceId) {
  try {
    const Product = require("./models/Product");
    const products = await Product.find(withWorkspace({ active: true }, workspaceId)).limit(50).lean();
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

async function handleProductSelection(from, productId, variantLabel, workspaceId) {
  try {
    const catalog = pendingCatalogs.get(from);
    const Product = require("./models/Product");

    let p = catalog?.products.find(x => x._id.toString() === productId);
    if (!p) p = await Product.findOne(scopedFilter(productId, workspaceId)).lean();
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
async function handleServicePromoInterest(from, promo, campaignMessageId, workspaceId) {
  try {
    const Service  = require("./models/Service");
    const TimeSlot = require("./models/TimeSlot");

    const services = promo.services?.length ? promo.services : await Service.find(withWorkspace({ active: true }, workspaceId)).limit(1);
    if (!services.length) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "Sorry, no services are available for this promotion right now." } });
      return;
    }

    // Use first service in promotion (or only service)
    const service = services[0];
    const today   = new Date().toISOString().slice(0, 10);
    const slots   = await TimeSlot.find(withWorkspace({
      serviceId:   service._id,
      date:        { $gte: today },
      $expr:       { $lt: ["$bookedCount", "$capacity"] },
    }, workspaceId)).sort({ date: 1, startTime: 1 }).limit(10);

    pendingSlotSelections.set(from, { service, promotion: promo, slots, isFree: false, campaignMessageId, workspaceId });
    await sendServiceSlots(from, service, slots, promo._id.toString(), false);
  } catch (err) {
    console.error("handleServicePromoInterest error:", err.message);
  }
}

// Customer picked a time slot from a service promo
async function handleSlotSelection(from, slotId, isFree, oldBookingId, workspaceId) {
  try {
    const TimeSlot = require("./models/TimeSlot");
    const Service  = require("./models/Service");
    const Customer = require("./models/Customer");
    const Booking  = require("./models/Booking");

    const pending  = pendingSlotSelections.get(from);
    workspaceId    = pending?.workspaceId || workspaceId;
    const slot     = await TimeSlot.findOne(scopedFilter(slotId, workspaceId));
    if (!slot) return;

    const service  = pending?.service || await Service.findOne(scopedFilter(slot.serviceId, workspaceId));
    const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));

    if (!slot || slot.bookedCount >= slot.capacity) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "⚠️ Sorry, that slot just got booked up. Please pick another time." } });
      return;
    }

    if (isFree) {
      // Rescheduling — free, no payment needed
      await TimeSlot.findOneAndUpdate(scopedFilter(slotId, workspaceId), { $inc: { bookedCount: 1 } });

      // If rescheduling an existing booking, mark old one rescheduled
      if (oldBookingId) {
        await Booking.findOneAndUpdate(scopedFilter(oldBookingId, workspaceId), { status: 'rescheduled' });
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
        workspaceId,
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
      pendingServiceCheckouts.set(from, { service, slot, promotion, totalPointsCost: pointsCost, workspaceId });
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
          ...((slot.workspaceId || workspaceId) ? { workspaceId: String(slot.workspaceId || workspaceId) } : {}), // the Stripe webhook resolves the customer (tenant) from this
        },
      });

      pendingSlotSelections.delete(from);
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: `📋 *${service.name}*\n📅 ${slot.date} at ${slot.startTime}–${slot.endTime}\n💰 ${money(amount, currency)}\n\nPay securely to confirm your booking:\n${APP_URL}/pay/${pi.id}` } });

      // Second option — hold the slot without paying online; the merchant reviews and confirms.
      pendingPayLaterSlots.set(from, { service, slot, workspaceId });
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
    const workspaceId = pending.workspaceId;

    const TimeSlot = require("./models/TimeSlot");
    const Customer = require("./models/Customer");
    const Booking  = require("./models/Booking");

    const { service, slot } = pending;
    const freshSlot = await TimeSlot.findOne(scopedFilter(slot._id, workspaceId));
    if (!freshSlot || freshSlot.bookedCount >= freshSlot.capacity) {
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "⚠️ Sorry, that slot just got booked up. Please pick another time." } });
      return;
    }

    await TimeSlot.findOneAndUpdate(scopedFilter(slot._id, workspaceId), { $inc: { bookedCount: 1 } });
    const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
    await Booking.create({
      serviceId:    service._id,
      slotId:       slot._id,
      customerId:   customer?._id,
      phone:        from,
      customerName: customer ? `${customer.firstname || ''} ${customer.lastname || ''}`.trim() : from,
      status:       'requested',
      paymentType:  'pay_later',
      amount:       service.basePrice || 0,
      workspaceId,
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
async function handleRebookRequest(from, serviceId, oldBookingId, flowEnrollmentId, workspaceId) {
  try {
    const Service  = require("./models/Service");
    const TimeSlot = require("./models/TimeSlot");

    const service = await Service.findOne(scopedFilter(serviceId, workspaceId));
    if (!service) return;

    const today = new Date().toISOString().slice(0, 10);
    const slots = await TimeSlot.find(withWorkspace({
      serviceId,
      date:  { $gte: today },
      $expr: { $lt: ["$bookedCount", "$capacity"] },
    }, workspaceId)).sort({ date: 1, startTime: 1 }).limit(10);

    pendingSlotSelections.set(from, { service, promotion: null, slots, isFree: true, oldBookingId, flowEnrollmentId, workspaceId });
    await sendServiceSlots(from, service, slots, null, true);
  } catch (err) {
    console.error("handleRebookRequest error:", err.message);
  }
}

// ─── WhatsApp incoming messages ──────────────────────────────────────────────
// Meta may batch several entries / changes / messages into ONE POST: every one is processed. Each EVENT is attributed to
// its own customer (workspace) — the customer's own number, the wamid it replies to, the id in its button payload, or the
// phone it comes from; the OLDEST workspace when nothing says otherwise (see shared/whatsappInbound.js).
app.post("/webhook", webhookSignatureGate, async (req, res) => {
  res.sendStatus(200);
  try { const ob = require("./shared/onboarding/webhookEvents"); if (ob.enabled() && await ob.intercept(req)) return; } catch (_) { /* fail open: existing flow */ } // WhatsApp onboarding: merchant-WABA events only
  try { await handleWebhookBody(req); }
  catch (err) { console.error("[webhook] processing failed:", err && err.message); }
});

// Runs fn in a fresh async scope: the AsyncLocalStorage contexts one event enters (sender, Arabic localisation) must not
// leak into the next event of the same POST.
const isolated = (fn) => Promise.resolve().then(fn);

// 'valid' | 'invalid' | 'missing' | 'unconfigured' — what captureWebhookSignature (above) worked out for THIS request.
// ('absent' is the spelling of the onboarding middleware, which reads the body first when ONBOARDING_FLOW is on.)
function webhookSignatureOf(req) {
  const s = req.metaSignature;
  if (s === "valid" || s === "invalid" || s === "unconfigured") return s;
  return "missing";
}

// How much one request may make this server do: everything when Meta signed it, a capped share otherwise (shared/webhookBudget.js).
const { MAX_UNSIGNED_EVENTS, MAX_UNSIGNED_STATUSES, TEMPLATE_EVENT_COST, newBudget, takeEvents, takeStatuses } = require("./shared/webhookBudget");

async function handleWebhookBody(req) {
  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  if (!entries.length) return;
  const signature = webhookSignatureOf(req);
  const budget = newBudget(signature);
  let oldestWorkspaceId;
  let lookupFailed = false;
  try {
    // retried like the per-event lookups: one throttled query must not cost the whole request (a typed STOP included)
    oldestWorkspaceId = await whatsappInbound.withRetries(undefined, () => resolveWebhookWorkspaceId());
  } catch (err) {
    lookupFailed = true;
    console.error(`[webhook] the oldest workspace could not be looked up (${err && err.message}): the messages of this request cannot be attributed (a typed STOP is still honoured); delivery updates and template news are handled on their own`);
  }
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      try {
        const value = change?.value;
        const isMessages = change?.field !== "message_template_status_update" && value && !value.statuses?.length;
        if (lookupFailed && isMessages) {
          for (const message of takeEvents(budget, value.messages)) {
            try { await handleUnattributedMessage({ message, value, signature }); }
            catch (e) { console.error("[webhook] unattributed message not handled:", e && e.message); }
          }
        } else {
          // delivery updates attribute themselves by message id and template news works from the template name: neither needs the oldest
          // workspace (left undefined after a failed lookup, it is only looked up again - with retries - for an update nothing claims)
          await handleWebhookChange({ change, signature, oldestWorkspaceId, budget });
        }
      } catch (err) { console.error("[webhook] change not processed:", err && err.message); }
    }
  }
  if (budget.skipped) console.warn(`[webhook] ${budget.skipped} event(s) of a request without a valid signature were NOT processed (at most ${MAX_UNSIGNED_EVENTS} messages or template changes and ${MAX_UNSIGNED_STATUSES} delivery updates per such request)`);
}

async function handleWebhookChange({ change, signature, oldestWorkspaceId, budget = newBudget("valid") }) {
  const value = change?.value;

  // Template approval news (Meta tells us a template changed status): the handler re-reads the real status itself.
  if (change?.field === "message_template_status_update") {
    if (!takeEvents(budget, [change], TEMPLATE_EVENT_COST).length) return;
    try { await require("./shared/templateApproval").handleTemplateStatusEvent({ value, change, signature }); }
    catch (err) { console.error("[webhook] template status event not handled:", err && err.message); }
    return;
  }
  if (!value) return;

  // Delivery/read/failed callbacks for outbound messages — no inbound message here. Grouped per customer (workspace).
  if (value.statuses?.length) {
    const statuses = takeStatuses(budget, value.statuses);
    if (!statuses.length) return;
    const groups = await whatsappInbound.resolveStatusGroups({ value, statuses, oldestWorkspaceId });
    for (const group of groups) {
      if (group.rule === "R3_error") { // the lookup kept failing: whose messages these are is unknown, so none is updated
        console.error(`[webhook] ${group.statuses.length} delivery update(s) NOT applied: their customer could not be determined (database lookup failed)`);
        continue;
      }
      await handleStatusCallbacks(group.statuses, group.workspaceId);
    }
    return;
  }

  const messages = takeEvents(budget, value.messages);
  for (const message of messages) {
    try {
      await isolated(async () => {
        const { workspaceId, rule } = await whatsappInbound.resolveEventWorkspace({ value, message, oldestWorkspaceId });
        if (rule === "R3_error") { await handleUnattributedMessage({ message, value, signature }); return; }
        if (String(workspaceId) !== String(oldestWorkspaceId)) console.log(`[webhook] event attributed to workspace ${workspaceId} (${rule})`);
        // every WhatsApp send below goes out from this customer's number - or, for an event that arrived on the SHARED number, from the
        // shared number (the customer's 24-hour window is with it, even if the customer has a number of its own by now)
        senderContext.enter(workspaceId, { viaPlatformNumber: rule !== "R1_phone_id" });
        await processInboundMessage({ value, message, workspaceId, signature, rule, oldestWorkspaceId });
      });
    } catch (err) {
      console.error("[webhook] message not processed:", err && err.message);
    }
  }
}

// A phone number for the log: only its last four digits.
const maskedPhone = (v) => String(v == null ? "" : v).replace(/\d(?=\d{4})/g, "*");

// CONSENT_REQUIRE_SIGNATURE=on: a customer's own opt-in tap counts only when Meta signed the request (an opt-out always counts).
function optInTapAllowed(signature) {
  if (!require("./shared/consent").requireSignature()) return true;
  if (signature === "valid") return true;
  console.warn(`[webhook] an opt-in tap was ignored: CONSENT_REQUIRE_SIGNATURE is on and the webhook signature was "${signature || "missing"}"`);
  return false;
}

// Does this inbound message ask to stop? A typed STOP / UNSUBSCRIBE, or a tapped Opt Out button (the older `optout_<id>` payload or a
// consent request's `promo:<id>:opt_out:<n>`). None of them needs to know whose message it is to be honoured.
function stopRequestOf(message) {
  if (!message) return null;
  if (message.type === "text") {
    const typed = String(message.text?.body || "").trim().toUpperCase();
    return typed === "STOP" || typed === "UNSUBSCRIBE"
      ? { method: "whatsapp_stop_command", source: "WhatsApp STOP reply (customer could not be identified at the time)", messageText: message.text.body }
      : null;
  }
  const payload = String(message.button?.payload || message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || "");
  return /^optout_/.test(payload) || /^promo:[0-9a-f]{24}:opt_out:[0-9]+$/i.test(payload)
    ? { method: "whatsapp_optout_button", source: "Opt Out button (customer could not be identified at the time)", messageText: "" }
    : null;
}

// The database lookup that says WHOSE message this is kept failing (shared/whatsappInbound.js tried several times). Filing it under
// the oldest workspace would put another customer's phone number and words into that customer's inbox, so nothing is written
// (no inbox entry, no customer, no flow). The one thing that needs no attribution is honoured: a typed STOP or a tapped Opt Out
// opts the number out in EVERY customer that has it (the number it arrived on is unknown, so a customer with a number of its own
// is included too). It is confirmed to the person only when something really was opted out and the message came in on the platform
// number (a reply can only leave from there). Everything else is logged loudly; WhatsApp is not asked to redeliver (the webhook was
// answered before processing), so the person simply sends it again.
async function handleUnattributedMessage({ message, value, signature }) {
  const from = message && message.from;
  console.error(`[webhook] message from ${maskedPhone(from)} NOT processed: its customer could not be determined (database lookup failed)`);
  const stop = from ? stopRequestOf(message) : null;
  if (!stop) return;
  const arrivedOn = value && value.metadata && value.metadata.phone_number_id;
  const onPlatformNumber = !arrivedOn || String(arrivedOn) === String(whatsappInbound.platformPhoneId());
  await require("./shared/crossWorkspaceOptOut").optOutEverywhere({
    from, method: stop.method, source: stop.source, messageText: stop.messageText, wamid: message.id, signature,
    unattributed: true, silent: !onPlatformNumber,
  });
}

// One inbound message, already attributed to its workspace (`rule` = how: see shared/whatsappInbound.js; R1_phone_id means
// it arrived on the customer's OWN number). The body is the original single-message webhook handler.
async function processInboundMessage({ value, message, workspaceId, signature, rule, oldestWorkspaceId }) {
  localization.enterContext(workspaceId); // Arabic localisation: scopes the outbound-language lookup to this message's workspace (never throws)

  const from = message.from;
  // A customer's phone number and words are personal data, and the log stream is kept and read by more people than the database is.
  // By default only the kind of message, the last four digits of the number and the message id are logged;
  // WEBHOOK_LOG_BODIES=on (for a short while, while debugging) logs the whole message as it always did.
  if (envFlag.isOn("WEBHOOK_LOG_BODIES", false)) console.log(`Incoming from ${from}:`, JSON.stringify(message, null, 2));
  else console.log(`Incoming ${message.type || "message"} from ${maskedPhone(from)} (${message.id || "no id"})`);

  // WhatsApp Inbox — log every inbound message into the merchant-facing
  // conversation thread before any of the existing shopping/flow dispatch
  // below runs. Never throws (self-contained try/catch inside), so a logging
  // failure can never block the customer-facing flow that follows.
  const contactName = value?.contacts?.[0]?.profile?.name;

  // Referral Promotions runs FIRST, ahead of the Inbox hook below — it needs
  // to know whether this phone was already a known customer *before this
  // message* (its own abuse-prevention rule: a phone already known to the
  // merchant shouldn't count as a referred "new customer"). The Inbox hook
  // right after this one also auto-creates a Customer for any inbound
  // message, which would make every phone look "already known" if it ran
  // first. Detects a "Code: XXXXXXXXXX" referral code in the inbound text
  // (present only on messages that arrived via a referral deep link); a
  // no-op for every other message. Never throws, same reasoning as Inbox.
  await referrals.handleInboundReferralCode({ workspaceId, from, message, contactName })
    .catch(err => console.error("referrals handleInboundReferralCode error:", err.message));

  // Instagram Promotion Scheduler — same "must run before Inbox's auto-
  // create" reasoning as Referral Promotions above. Detects its own
  // distinct "Code: IG-XXXXXXXX" pattern (never ambiguous with the Referral
  // Promotions feature's plain-hex code — see shared/instagram.js).
  await instagram.handleInboundTrackingCode({ workspaceId, from, message, contactName })
    .catch(err => console.error("instagram handleInboundTrackingCode error:", err.message));

  // WhatsApp Inbox — log every inbound message into the merchant-facing
  // conversation thread before any of the existing shopping/flow dispatch
  // below runs. Never throws (self-contained try/catch inside), so a logging
  // failure can never block the customer-facing flow that follows.
  // The Inbox hook creates a Customer for any sender it does not know. That is today's behaviour for the oldest workspace
  // and for a customer's OWN number (rule R1_phone_id: whoever writes to that number is theirs). In any OTHER customer's
  // workspace an event that only reached it through a button payload / replied-to message must not create a customer out
  // of a stranger's phone, so there it is logged only when the phone is already known there.
  let logInbound = true;
  if (rule && rule !== "R1_phone_id" && oldestWorkspaceId !== undefined && String(workspaceId) !== String(oldestWorkspaceId)) {
    logInbound = await whatsappInbound.customerKnownInWorkspace(workspaceId, from);
    if (!logInbound) console.warn(`[webhook] not creating a customer from an unknown phone in workspace ${workspaceId} (event attributed by ${rule})`);
  }
  if (logInbound) await inbox.logInboundMessage({ workspaceId, from, message, contactName })
    .catch(err => console.error("inbox logInboundMessage error:", err.message));

  // Arabic localisation — honours typed Arabic opt-out/opt-in keywords and Arabic
  // consent buttons immediately, and records a customer's language from their
  // first message (see shared/localization/inboundHook.js). Never throws; returns
  // true ONLY when it fully handled the message, otherwise the existing flow runs.
  if (await localization.handleInbound({ workspaceId, from, message, contactName })) return;

  // ── Template quick-reply (user tapped button on a template message) ──────────
  if (message.type === "button") {
    const payload = message.button?.payload || "";
    if (payload.startsWith("promo:")) {
      // Consent-request buttons (opt in / opt out / interested) of a promotion — see shared/promoConsentTap.js. The workspace,
      // customer and exact text shown come from the CampaignMessage the tap replies to, not from the payload alone.
      await handlePromoConsentTapSafe({ from, message, signature, workspaceId });
    } else if (payload.startsWith("promo_")) {
      const promoId = payload.slice(6);
      const cm = await correlateClick({ from, wamid: message.context?.id, promotionId: promoId, workspaceId });
      await handlePromoInterest(from, promoId, cm?._id, workspaceId);
    } else if (payload.startsWith("flowbrowse_")) {
      const cm = await correlateClick({ from, wamid: message.context?.id, workspaceId });
      await handleFlowBrowse(from, cm?._id, workspaceId);
    } else if (payload.startsWith("flownoshow_")) {
      const parts     = payload.slice(11).split("_");
      const serviceId = parts[0];
      const bookingId = parts[1];
      const cm = await correlateClick({ from, wamid: message.context?.id, workspaceId });
      await handleRebookRequest(from, serviceId, bookingId, cm?.flowEnrollment, workspaceId);
    } else if (payload.startsWith("msgnode_")) {
      // Entry-node tap — always arrives here since the entry message is always
      // a template (see models/MessageNode.js).
      const parts = payload.slice(8).split("_");
      await handleMessageNodeTap({ from, wamid: message.context?.id, nodeId: parts[0], position: +parts[1], workspaceId });
    } else if (payload.startsWith("consent_yes_")) {
      // Same consent_yes_/consent_no_ scheme as the free-form interactive ask
      // on order/booking confirmations — this branch is the bulk consent-
      // request campaign's template quick-reply instead (see shared/
      // operations.js#sendConsentRequests), a different WhatsApp message
      // shape but the same customerId payload and consent write-path.
      const Customer = require("./models/Customer");
      const { grantMarketingConsent } = require("./shared/consent");
      await correlateClick({ from, wamid: message.context?.id, workspaceId });
      const customer = await Customer.findOne(withWorkspace({ _id: payload.slice(12) }, workspaceId));
      if (customer && optInTapAllowed(signature)) {
        await grantMarketingConsent({ customer, method: 'whatsapp_button', source: 'bulk consent-request campaign', workspaceId });
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "🎉 You're subscribed! We'll send occasional offers and updates. Reply STOP anytime to opt out." } }).catch(() => {});
      }
    } else if (payload.startsWith("consent_no_")) {
      const Customer = require("./models/Customer");
      const { declineMarketingConsent } = require("./shared/consent");
      await correlateClick({ from, wamid: message.context?.id, workspaceId });
      const customer = await Customer.findOne(withWorkspace({ _id: payload.slice(11) }, workspaceId));
      if (customer) {
        await declineMarketingConsent({ customer, method: 'whatsapp_button', source: 'bulk consent-request campaign', workspaceId });
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "No problem! You can always opt in later." } }).catch(() => {});
      }
    } else if (payload.startsWith("optout_")) {
      // The "Opt Out" quick-reply on the template fallback of a promo send
      // (see utils/whatsapp.js#createPromoTemplate/sendPromoTemplate). Resolved
      // by phone rather than an embedded customer id — same lookup STOP already
      // uses — since this button always applies to whoever tapped it, regardless
      // of which promotion carried it. withdrawMarketingConsent runs
      // unconditionally (no "already opted out" skip), so it's always safe to
      // re-tap.
      const Customer = require("./models/Customer");
      const { withdrawMarketingConsent } = require("./shared/consent");
      await correlateClick({ from, wamid: message.context?.id, promotionId: payload.slice(7), workspaceId });
      const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
      if (customer) {
        await withdrawMarketingConsent({ customer, method: 'whatsapp_optout_button', source: `Opt Out button on promotion ${payload.slice(7)}`, workspaceId });
        await waPost({ messaging_product: "whatsapp", to: from, type: "text",
          text: { body: "You've been unsubscribed from promotional messages. Reply START to opt back in anytime." } }).catch(() => {});
      }
      await localization.optOutSamePhone({ workspaceId, from, exceptCustomerId: customer && customer._id, method: 'whatsapp_optout_button', source: `Opt Out button on promotion ${payload.slice(7)}` }); // H1: every record of this number
    } else if (payload.startsWith("cart_")) {
      // "Add to Cart" tapped on a horizontal-carousel template card (see
      // shared/promotionCarousel.js) — a carousel is always a template
      // message, so this tap arrives here rather than in the interactive
      // button_reply chain below where the existing per-card flow's cart_
      // handling already lives. Resolves to the exact same, unmodified handler.
      await handleProductSelection(from, payload.slice(5), "", workspaceId);
    } else if (payload.startsWith("carouselsvc_")) {
      // "Book Now" tapped on a service-carousel card — see
      // shared/promotionCarousel.js#handleCarouselServiceSelection.
      const { handleCarouselServiceSelection } = require("./shared/promotionCarousel");
      const [serviceId, promoId] = payload.slice(12).split("_");
      await handleCarouselServiceSelection(from, serviceId, promoId, workspaceId);
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
          await handleProductSelection(from, productId, label, workspaceId);
        }
      } else if (rowId.startsWith("slot_")) {
        await handleSlotSelection(from, rowId.slice(5), false, null, workspaceId);
      } else if (rowId.startsWith("reslot_")) {
        const pending = pendingSlotSelections.get(from);
        await handleSlotSelection(from, rowId.slice(7), true, pending?.oldBookingId || null, workspaceId);
      } else if (rowId.startsWith("cart_")) {
        // Product row from list fallback
        await handleProductSelection(from, rowId.slice(5), "", workspaceId);
      }
      return;
    }

    // Button reply
    if (message.interactive.type === "button_reply") {
      const buttonId = message.interactive.button_reply.id;
      console.log(`Button: ${buttonId} from ${maskedPhone(from)}`);

      if (buttonId.startsWith("rebook_")) {
        // Customer tapped "Rebook Free" from cancellation message
        const parts     = buttonId.slice(7).split("_");
        const serviceId = parts[0];
        const bookingId = parts[1];
        await handleRebookRequest(from, serviceId, bookingId, undefined, workspaceId);

      } else if (buttonId.startsWith("paylater_")) {
        // Customer tapped "Reserve, Pay in Person" instead of the Stripe link
        await handlePayLaterReservation(from, buttonId.slice(9));

      } else if (buttonId.startsWith("promo_")) {
        // "Shop Now" / "Book Now" tapped on promo message → show catalog or slots
        const promoId = buttonId.slice(6);
        const cm = await correlateClick({ from, wamid: message.context?.id, promotionId: promoId, workspaceId });
        await handlePromoInterest(from, promoId, cm?._id, workspaceId);

      } else if (buttonId.startsWith("msgnode_")) {
        // Deeper-node tap — always arrives here since follow-up MessageNodes
        // are always sent free-form (see models/MessageNode.js).
        const parts = buttonId.slice(8).split("_");
        await handleMessageNodeTap({ from, wamid: message.context?.id, nodeId: parts[0], position: +parts[1], workspaceId });

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
        await handleProductSelection(from, buttonId.slice(5), "", workspaceId);

      } else if (buttonId.startsWith("carouselsvc_")) {
        // Defense-in-depth parity with the template chain above — a service
        // carousel is always sent as a template today, so this branch isn't
        // currently reachable via button_reply, but costs nothing to keep in
        // sync (see shared/promotionCarousel.js#handleCarouselServiceSelection).
        const { handleCarouselServiceSelection } = require("./shared/promotionCarousel");
        const [serviceId, promoId] = buttonId.slice(12).split("_");
        await handleCarouselServiceSelection(from, serviceId, promoId, workspaceId);

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
        const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
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
        const customer  = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
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

      } else if (buttonId.startsWith("consent_yes_")) {
        const Customer = require("./models/Customer");
        const { grantMarketingConsent } = require("./shared/consent");
        const customer = await Customer.findOne(withWorkspace({ _id: buttonId.slice(12) }, workspaceId));
        if (customer && optInTapAllowed(signature)) {
          await grantMarketingConsent({ customer, method: 'whatsapp_button', source: 'order/booking confirmation consent button', workspaceId });
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "🎉 You're subscribed! We'll send occasional offers and updates. Reply STOP anytime to opt out." } }).catch(() => {});
        }

      } else if (buttonId.startsWith("consent_no_")) {
        const Customer = require("./models/Customer");
        const { declineMarketingConsent } = require("./shared/consent");
        const customer = await Customer.findOne(withWorkspace({ _id: buttonId.slice(11) }, workspaceId));
        if (customer) {
          await declineMarketingConsent({ customer, method: 'whatsapp_button', source: 'order/booking confirmation consent button', workspaceId });
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "No problem! You can always opt in later." } }).catch(() => {});
        }

      } else if (buttonId.startsWith("optout_")) {
        // The "Opt Out" quick-reply on the interactive (session-window) promo
        // send — see utils/whatsapp.js#buildPromoAnnouncementPayload/
        // buildPointsPromoPayload. Same withdrawMarketingConsent path as the
        // template fallback's optout_ branch above; always runs, never skips
        // even if the customer is already opted out.
        const Customer = require("./models/Customer");
        const { withdrawMarketingConsent } = require("./shared/consent");
        const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
        if (customer) {
          await withdrawMarketingConsent({ customer, method: 'whatsapp_optout_button', source: `Opt Out button on promotion ${buttonId.slice(7)}`, workspaceId });
          await waPost({ messaging_product: "whatsapp", to: from, type: "text",
            text: { body: "You've been unsubscribed from promotional messages. Reply START to opt back in anytime." } }).catch(() => {});
        }
        await localization.optOutSamePhone({ workspaceId, from, exceptCustomerId: customer && customer._id, method: 'whatsapp_optout_button', source: `Opt Out button on promotion ${buttonId.slice(7)}` }); // H1: every record of this number
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
    // On the shared platform number (every rule except the customer's OWN number, R1) the phone is opted out / back in
    // in every workspace that has it — see shared/crossWorkspaceOptOut.js. A customer's own number: this workspace only.
    const sharedNumber = rule !== "R1_phone_id";
    if ((upperText === "STOP" || upperText === "UNSUBSCRIBE") && sharedNumber) {
      await require("./shared/crossWorkspaceOptOut").optOutEverywhere({ from, method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply', messageText: text, wamid: message.id, workspaceId, signature });
      return;
    }
    if ((upperText === "START" || upperText === "SUBSCRIBE") && sharedNumber) {
      await require("./shared/crossWorkspaceOptOut").startEverywhere({ from, method: 'whatsapp_start_command', source: 'WhatsApp START reply', messageText: text, wamid: message.id, workspaceId, signature });
      return;
    }
    if (upperText === "STOP" || upperText === "UNSUBSCRIBE") {
      const Customer = require("./models/Customer");
      const { withdrawMarketingConsent } = require("./shared/consent");
      const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
      if (customer) await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply', workspaceId });
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: "You've been unsubscribed from promotional messages. Reply START to opt back in anytime." } }).catch(() => {});
      await localization.optOutSamePhone({ workspaceId, from, exceptCustomerId: customer && customer._id, method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply' }); // H1: every record of this number
      return;
    }
    if (upperText === "START" || upperText === "SUBSCRIBE") {
      const Customer = require("./models/Customer");
      const { reinstateMarketingConsent } = require("./shared/consent");
      const customer = await Customer.findOne(withWorkspace({ phone: from }, workspaceId));
      // A START from an opted-out customer is a fresh, customer-initiated opt-in: recorded with its evidence (the words they typed, the
      // WhatsApp message id, the webhook signature) and, with CONSENT_REQUIRE_SIGNATURE=on, only when Meta signed the request. A
      // customer who never opted in and never opted out is left as they are: a bare START never fabricates consent.
      const reinstated = customer ? await reinstateMarketingConsent({
        customer, method: 'whatsapp_start_command', source: 'WhatsApp START reply', workspaceId, signature,
        ...(customer.optedOut === true ? { evidence: { messageText: text, inboundWamid: message.id, signature } } : {}),
      }) : false;
      await waPost({ messaging_product: "whatsapp", to: from, type: "text",
        text: { body: reinstated
          ? "You're subscribed to promotional messages again. Welcome back! 🎉"
          : "Got it — you won't receive promotional messages unless you opt in." } }).catch(() => {});
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
            withWorkspace({ phone: from, loyaltyPoints: { $gte: pending.totalPointsCost } }, pending.workspaceId),
            { $inc: { loyaltyPoints: -pending.totalPointsCost }, $set: { loyaltyPointsUpdatedAt: new Date() } },
            { new: true }
          );
          if (!customer) {
            await waPost({ messaging_product: 'whatsapp', to: from, type: 'text',
              text: { body: '⚠️ Insufficient points. Booking could not be completed.' } }).catch(() => {});
            return;
          }
          await TimeSlot.findOneAndUpdate(scopedFilter(pending.slot._id, pending.workspaceId), { $inc: { bookedCount: 1 } });
          await Booking.create({
            serviceId:    pending.service._id,
            slotId:       pending.slot._id,
            customerId:   customer._id,
            phone:        from,
            customerName: `${customer.firstname || ''} ${customer.lastname || ''}`.trim(),
            status:       'confirmed',
            paymentType:  'points',
            pointsUsed:   pending.totalPointsCost,
            workspaceId:  pending.workspaceId,
          });
          const { sendUtilityMessageWithConsentAsk } = require('./shared/consent');
          await sendUtilityMessageWithConsentAsk({
            customer, workspaceId: pending.workspaceId,
            body: `✅ *Booked!*\n\n📋 ${pending.service.name}\n📅 ${pending.slot.date} at ${pending.slot.startTime}\n💎 ${pending.totalPointsCost} points redeemed\n\nRemaining points: ${customer.loyaltyPoints} pts\n\nSee you then! 🎉`,
          }).catch(() => {});
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
            withWorkspace({ phone: from, loyaltyPoints: { $gte: pending.totalPointsCost } }, pending.workspaceId),
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
              workspaceId:      customer.workspaceId,
            });
            if (pending.campaignMessageId) {
              await CampaignMessage.findByIdAndUpdate(pending.campaignMessageId, { order: order._id }).catch(() => {});
            }
          }
          const { sendUtilityMessageWithConsentAsk } = require('./shared/consent');
          await sendUtilityMessageWithConsentAsk({
            customer, workspaceId: pending.workspaceId,
            body: `✅ *Order Confirmed!*\n\n💎 ${pending.totalPointsCost} points redeemed successfully.\n📍 Delivering to: ${pending.address}\n\nRemaining points: ${customer.loyaltyPoints} pts\n\nThank you for shopping with us! 🎉`,
          }).catch(() => {});
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
      const customer = await Customer.findOneAndUpdate(withWorkspace({ phone: from }, workspaceId), { address: text }, { new: true });
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
      await handleProductSelection(from, products[i]._id.toString(), "", workspaceId);
    }
  }
}

// POST /send-message (an unauthenticated route that sent WhatsApp messages from the platform number to any phone) was removed: nothing used it.
app.get("/", (req, res) => res.send("Waflow backend running"));

// Guarded so tests can `require('./server')` for its exported `app` (Supertest)
// without also binding a port or kicking off the WA token refresh.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    tokenManager.init(); // validate + auto-refresh WA token in background
    require("./utils/flowScheduler").startFlowScheduler();
    referrals.startReferralScheduler();
    instagram.startInstagramScheduler();
    try { require("./shared/localization/scheduler").startLocalizationScheduler(); }
    catch (err) { console.error("[localization] scheduler not started:", err.message); }
    try { require("./shared/onboarding/scheduler").startOnboardingScheduler(); }
    catch (err) { console.error("[onboarding] scheduler not started:", err.message); }
    // Meta template approvals (every 5 minutes): tells merchants when a message they submitted has been approved.
    try { require("./shared/templateApproval").startTemplateApprovalSweeper(); }
    catch (err) { console.error("[templateApproval] sweeper not started:", err.message); }
  });
}

module.exports = app;
