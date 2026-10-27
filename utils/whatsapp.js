const axios       = require('axios');
const FormData    = require('form-data');
const mime        = require('mime-types');
const waTenant     = require('./waTenant');
const { money }    = require('./currency');
const { getCurrency } = require('./settingsCache');

// Which number a call goes out from is NOT decided here any more: every Graph call below resolves its sender (phone id,
// WABA, access token) ONCE at entry through waTenant.resolveCurrent() - the logged-in customer's own number when it has one,
// the platform number otherwise (utils/waTenant.js, utils/senderContext.js). For the platform sender every request is exactly
// what it was before (same method, URL, params, body, headers).
const WA_BASE = waTenant.GRAPH_BASE; // https://graph.facebook.com/v25.0

// Template names — override via env vars
// v2 — added the Opt Out quick-reply button. Meta doesn't let an already-
// approved template's button structure be changed in place (ensureTemplateExists
// only ever creates a template once, never re-submits an existing name), so
// this needed a new template name to actually pick up the change, rather than
// silently keeping the old 1-button version live.
const PROMO_TEMPLATE   = process.env.WA_PROMO_TEMPLATE   || 'waflow_promo_v2';
const LOYALTY_TEMPLATE = process.env.WA_LOYALTY_TEMPLATE || 'waflow_loyalty';
const WINBACK_TEMPLATE = process.env.WA_WINBACK_TEMPLATE || 'waflow_winback';
const POST_PURCHASE_TEMPLATE = process.env.WA_POST_PURCHASE_TEMPLATE || 'waflow_post_purchase';
const POINTS_NUDGE_TEMPLATE = process.env.WA_POINTS_NUDGE_TEMPLATE || 'waflow_points_nudge';
const NO_SHOW_TEMPLATE = process.env.WA_NO_SHOW_TEMPLATE || 'waflow_no_show';
const OTP_TEMPLATE = process.env.WA_OTP_TEMPLATE || 'waflow_login_otp';
const INVITE_TEMPLATE = process.env.WA_INVITE_TEMPLATE || 'waflow_team_invite';
const CONSENT_REQUEST_TEMPLATE = process.env.WA_CONSENT_REQUEST_TEMPLATE || 'waflow_consent_request';

// ── Helpers ───────────────────────────────────────────────────────────────────

// WhatsApp Cloud API rejects WebP for message images/headers (error 131053).
// Link-based headers are accepted at send time but fail async, so filter up front.
function isSupportedImageLink(url) {
  return !!url && !/\.webp(?:$|\?)/i.test(url);
}

function headersFor(sender) {
  return {
    Authorization:  `Bearer ${sender.token}`,
    'Content-Type': 'application/json',
  };
}

// The sender for the work in progress. Throws WhatsAppNumberUnavailable (409) when the customer HAS its own number that
// cannot be used - never silently the platform number. waba:false: the send path never needs the WABA id (no Graph lookup).
const currentSender = () => waTenant.resolveCurrent({ waba: false });

// Sender + WABA id for template management, resolved once.
async function templateTarget() {
  const sender = await currentSender();
  const wabaId = await waTenant.wabaIdOf(sender);
  return { sender, wabaId };
}

async function waPost(body) {
  const sender = await currentSender();
  try { const out = require('../shared/localization').localizeOutbound(body); if (out !== body) body = await out; } catch (_) { /* fail open: original payload */ }
  const res = await axios.post(`${WA_BASE}/${sender.phoneId}/messages`, body, { headers: headersFor(sender) });
  return res.data;
}

// The WABA id of the number the current work sends from (the platform WABA unless the customer has its own).
async function getWabaId() {
  return waTenant.wabaIdOf(await currentSender());
}

async function uploadBuffer(sender, buffer, filename, contentType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, { filename, contentType });
  const res = await axios.post(
    `${WA_BASE}/${sender.phoneId}/media`,
    form,
    { headers: { Authorization: headersFor(sender).Authorization, ...form.getHeaders() } },
  );
  return res.data.id;
}

async function uploadFileBuffer(buffer, filename, contentType) {
  return uploadBuffer(await currentSender(), buffer, filename, contentType);
}

async function uploadMediaFromUrl(imageUrl) {
  const sender = await currentSender();
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const buffer      = Buffer.from(res.data);
  const contentType = res.headers['content-type'] || 'image/jpeg';
  const ext         = mime.extension(contentType) || 'jpg';
  return uploadBuffer(sender, buffer, `product.${ext}`, contentType);
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

const TEMPLATE_FIELDS = 'name,status,category,language,components,rejected_reason,quality_score';
const MAX_TEMPLATE_PAGES = 30; // 30 x 100 templates: far above any WABA's ceiling, but a loop can never run away

// Graph's paging.next is a full URL: only ever followed when it points at Graph itself (the token travels with it).
function nextTemplatePage(data) {
  const next = data && data.paging && data.paging.next;
  if (typeof next !== 'string') return null;
  try { return new URL(next).hostname === 'graph.facebook.com' ? next : null; } catch (_) { return null; }
}

// Pages through a WABA's templates. The first request is exactly the old single request (limit 100, same fields); further
// pages are fetched ONLY when Graph reports paging.next, and only while `stop(page)` says we still need more.
async function fetchTemplates(sender, wabaId, { name, stop } = {}) {
  const params = { limit: 100, fields: TEMPLATE_FIELDS };
  if (name) params.name = name;
  let res = await axios.get(`${WA_BASE}/${wabaId}/message_templates`, { headers: headersFor(sender), params });
  const all = [...(res.data.data || [])];
  for (let page = 1; page < MAX_TEMPLATE_PAGES; page++) {
    if (stop && stop(all)) break;
    const next = nextTemplatePage(res.data);
    if (!next) break;
    res = await axios.get(next, { headers: headersFor(sender) });
    all.push(...(res.data.data || []));
  }
  return all;
}

// opts.name narrows the list to templates whose name matches (Graph's `name` filter); no opts = the full list, as before.
async function listTemplates(opts = {}) {
  const { sender, wabaId } = await templateTarget();
  return fetchTemplates(sender, wabaId, { name: opts && opts.name });
}

// Looked up by name across ALL pages (stops at the first hit), so it keeps working past a WABA's first 100 templates.
async function getTemplate(name) {
  const { sender, wabaId } = await templateTarget();
  const found = (list) => list.some(t => t.name === name);
  const templates = await fetchTemplates(sender, wabaId, { stop: found });
  return templates.find(t => t.name === name) || null;
}

// DEFECT-05: these 6 fixed fallback templates (PROMO_TEMPLATE, LOYALTY_TEMPLATE,
// WINBACK_TEMPLATE, etc.) used to require a merchant to manually click "Create"
// in Settings before their first send would work. That manual step is now gone
// — each send*Template function below calls this first so a brand-new account
// (or one where a template got deleted) self-heals instead of failing forever.
// Scoped to "missing" only, not "rejected" — auto-recreating a rejected template
// blindly could hammer Meta's API in a loop if the body content is the actual
// problem; that edge case is out of scope here (visible via Settings' read-only
// status view, just not auto-fixed).
//
// The cache is keyed `${wabaId}|${name}`: a template found/created in one WABA says nothing about another customer's WABA.
const knownTemplates = new Set();

async function ensureTemplateExists(name, creatorFn) {
  let key;
  try {
    const { wabaId } = await templateTarget();
    key = `${wabaId}|${name}`;
  } catch (_) {
    // No usable sender / WABA (e.g. a customer's own number is broken): nothing can be looked up or created here. Never throws
    // (same contract as before); the send right after surfaces the real error.
    return;
  }
  if (knownTemplates.has(key)) return;
  try {
    if (await getTemplate(name)) { knownTemplates.add(key); return; }
  } catch (_) { /* listTemplates failed — fall through and attempt creation anyway */ }
  try {
    await creatorFn();
    knownTemplates.add(key);
  } catch (_) {
    // Might already exist (race with a concurrent send) or creation genuinely
    // failed — don't cache a failure; the send attempt right after this call
    // will surface the real error either way, and the next send retries fresh.
  }
}

// Meta rejects any BODY component containing {{n}} placeholders with
// rejected_reason: INVALID_FORMAT unless an example value is supplied for
// every placeholder (DEFECT-05/06 root cause — every template this app ever
// submitted was missing this). Values don't need to be the real ones that get
// substituted at send time, just plausible non-empty strings — Meta reviews
// the template structure/policy, not whether these specific words are exact.
const EXAMPLE_VALUE_POOL = ['Sarah', 'Blue T-Shirt', '20', 'SAR 45.00', 'Summer Sale', '350', 'Haircut', 'Friday 2pm'];

function exampleValuesFor(bodyText) {
  const slots = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map(m => +m[1]);
  const count = slots.length ? Math.max(...slots) : 0;
  return Array.from({ length: count }, (_, i) => EXAMPLE_VALUE_POOL[i % EXAMPLE_VALUE_POOL.length]);
}

function bodyComponentWithExample(text) {
  const component = { type: 'BODY', text };
  const values = exampleValuesFor(text);
  if (values.length) component.example = { body_text: [values] };
  return component;
}

// Authentication-category templates use a different shape than every other
// template in this app: Meta auto-generates the body text (no custom `text`
// field — just `add_security_recommendation`), and the OTP code is delivered
// via a dedicated OTP button rather than a plain quick-reply. Kept separate
// from createTemplate() rather than bent to fit its marketing-template shape.
// Creates a template in the WABA of the sender in force (one resolution per call).
async function postTemplate(payload) {
  const { sender, wabaId } = await templateTarget();
  const res = await axios.post(`${WA_BASE}/${wabaId}/message_templates`, payload, { headers: headersFor(sender) });
  return res.data;
}

async function createOtpTemplate() {
  return postTemplate({
    name: OTP_TEMPLATE,
    language: 'en',
    category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 5 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ],
  });
}

// OTP login codes and team invites are WaFlow's OWN messages (the person has no workspace yet / the invitee is not a customer
// of the inviter): they always go out from the PLATFORM number and use the platform WABA's templates, even when the request
// happens to run inside a customer's context.
async function sendOtpTemplate(to, code) {
  return waTenant.runPlatform(async () => {
    await ensureTemplateExists(OTP_TEMPLATE, createOtpTemplate);
    return waPost({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: OTP_TEMPLATE,
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: String(code) }] },
          { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: String(code) }] },
        ],
      },
    });
  });
}

async function createInviteTemplate() {
  // UTILITY, not AUTHENTICATION — this is a business notification (team
  // invite), not an OTP code, so it uses the same shape as every other
  // template in this app via createTemplate() rather than OTP's bespoke one.
  return createTemplate(INVITE_TEMPLATE, "Hi! You've been invited to join {{1}} on Waflow. Open the app and log in with this WhatsApp number to get started — no password needed.", 'UTILITY');
}

async function sendInviteTemplate(to, workspaceName) {
  return waTenant.runPlatform(async () => {
    await ensureTemplateExists(INVITE_TEMPLATE, createInviteTemplate);
    return waPost({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: INVITE_TEMPLATE,
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: workspaceName }] }],
      },
    });
  });
}

// UTILITY, not MARKETING — this message IS the compliance mechanism that
// captures marketing consent in the first place, so gating it behind prior
// consent would be circular. Same reasoning as createInviteTemplate above.
// Bulk consent-request sends (shared/operations.js#sendConsentRequests) go
// to an existing customer list, almost always outside the 24h session
// window — a real approved template is required, unlike the free-form
// interactive "Yes, sign me up" button that rides on order/booking
// confirmations (always inside the window since the customer just acted).
async function createConsentRequestTemplate() {
  return createTemplate(
    CONSENT_REQUEST_TEMPLATE,
    "Hi {{1}}! We'd love to keep you posted with occasional offers and updates from us on WhatsApp. Would you like to opt in?",
    'UTILITY',
    ['Yes, sign me up', 'No thanks'],
  );
}

// customerId fills both quick-reply button payloads so the webhook (button
// prefix dispatch in server.js) can resolve back to the exact customer,
// same consent_yes_/consent_no_ scheme the free-form interactive ask uses.
async function sendConsentRequestTemplate(to, customerName, customerId) {
  await ensureTemplateExists(CONSENT_REQUEST_TEMPLATE, createConsentRequestTemplate);
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: CONSENT_REQUEST_TEMPLATE,
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: customerName || 'there' }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `consent_yes_${customerId}` }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `consent_no_${customerId}` }] },
      ],
    },
  });
}

// opts.footer   footer line (default 'Reply STOP to unsubscribe'; null/'' = no footer)
// opts.language template language code (default 'en')
async function createTemplate(name, bodyText, category = 'MARKETING', buttonLabels = [], opts = {}) {
  const footer   = opts && opts.footer !== undefined ? opts.footer : 'Reply STOP to unsubscribe';
  const language = (opts && opts.language) || 'en';
  const components = [bodyComponentWithExample(bodyText)];
  if (footer) components.push({ type: 'FOOTER', text: footer });
  if (buttonLabels.length) {
    components.push({ type: 'BUTTONS', buttons: buttonLabels.map(text => ({ type: 'QUICK_REPLY', text })) });
  }
  return postTemplate({ name, language, category, components });
}

async function createPromoTemplate() {
  // Variables: {{1}} first name, {{2}} product name, {{3}} discount %, {{4}} sale price, {{5}} promo name, {{6}} currency code
  const body = 'Hi {{1}}! 🏷️ *{{2}}* is now *{{3}}% OFF* — only {{4}} {{6}}.\n\n{{5}}\n\nTap below to browse all products in this sale!';
  return postTemplate({
    name: PROMO_TEMPLATE,
    language: 'en',
    category: 'MARKETING',
    components: [
      bodyComponentWithExample(body),
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'Shop Now' },
        { type: 'QUICK_REPLY', text: 'Opt Out' },
      ] },
    ],
  });
}

async function deleteTemplate(name) {
  const { sender, wabaId } = await templateTarget();
  const res = await axios.delete(`${WA_BASE}/${wabaId}/message_templates`, {
    headers: headersFor(sender),
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
//
// Body copy is named here (not inlined below) so shared/operations.js#previewFlowMessage
// can render the exact same {{n}}-placeholder text a real send would use — no
// separate copy to fall out of sync when template wording changes.
const WINBACK_BODY = 'Hi {{1}}! 👋 It\'s been a while since we\'ve seen you.\n\nCome back and check out what\'s new — we\'d love to have you again! 🛍️';
const POST_PURCHASE_BODY = 'Hi {{1}}! 🎉 Thanks for your order!\n\nYou now have *{{2}} loyalty points* — come back and use them on your next visit!';
const POINTS_NUDGE_BODY = 'Hi {{1}}! 💎 You still have *{{2}} loyalty points* waiting to be used.\n\nCome in and redeem them before you forget!';
const NO_SHOW_BODY = 'Hi {{1}}! We missed you at your *{{2}}* appointment.\n\nNo worries — tap below to grab a new time, on us!';

async function createWinbackTemplate() {
  // Variables: {{1}} first name
  const body = WINBACK_BODY;
  return postTemplate({
    name: WINBACK_TEMPLATE,
    language: 'en',
    category: 'MARKETING',
    components: [
      bodyComponentWithExample(body),
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
    ],
  });
}

async function createPostPurchaseTemplate() {
  // Variables: {{1}} first name, {{2}} loyalty points
  const body = POST_PURCHASE_BODY;
  return postTemplate({
    name: POST_PURCHASE_TEMPLATE,
    language: 'en',
    category: 'MARKETING',
    components: [
      bodyComponentWithExample(body),
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
    ],
  });
}

async function createPointsNudgeTemplate() {
  // Variables: {{1}} first name, {{2}} loyalty points
  const body = POINTS_NUDGE_BODY;
  return postTemplate({
    name: POINTS_NUDGE_TEMPLATE,
    language: 'en',
    category: 'MARKETING',
    components: [
      bodyComponentWithExample(body),
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }] },
    ],
  });
}

async function createNoShowTemplate() {
  // Variables: {{1}} first name, {{2}} service name
  const body = NO_SHOW_BODY;
  return postTemplate({
    name: NO_SHOW_TEMPLATE,
    language: 'en',
    category: 'MARKETING',
    components: [
      bodyComponentWithExample(body),
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Rebook Free' }] },
    ],
  });
}

// ── Template sending ──────────────────────────────────────────────────────────

async function sendPromoTemplate(to, customer, product, promotion) {
  await ensureTemplateExists(PROMO_TEMPLATE, createPromoTemplate);
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
        // Dynamic quick-reply payloads carry the promotion ID back via webhook —
        // index must match each button's position in createPromoTemplate's BUTTONS array.
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `promo_${promotion._id}` }],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '1',
          parameters: [{ type: 'payload', payload: `optout_${promotion._id}` }],
        },
      ],
    },
  });
}

async function sendLoyaltyTemplate(to, customerName, loyaltyPoints) {
  await ensureTemplateExists(LOYALTY_TEMPLATE, createLoyaltyTemplate);
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
  await ensureTemplateExists(WINBACK_TEMPLATE, createWinbackTemplate);
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
  await ensureTemplateExists(POST_PURCHASE_TEMPLATE, createPostPurchaseTemplate);
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
  await ensureTemplateExists(POINTS_NUDGE_TEMPLATE, createPointsNudgeTemplate);
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

// ── Branching (see models/MessageNode.js) ──────────────────────────────────────

// Sends a merchant-authored custom Flow entry message as an approved WhatsApp
// Template. bodyParams fills {{1}}, {{2}}, ... positionally; buttonPayloads is
// one payload string per button (0-2), in the same order the template's BUTTONS
// component was submitted with.
//
// opts.language is the template's language code (default 'en'): it must match the language the template was submitted in.
async function sendCustomFlowTemplate(to, templateName, bodyParams, buttonPayloads, opts = {}) {
  const language = (opts && opts.language) || 'en';
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: language },
      components: [
        // A message with no {{n}} variable has no body component to fill (an empty one is not sent).
        ...(bodyParams.length ? [{
          type: 'body',
          parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })),
        }] : []),
        ...buttonPayloads.map((payload, index) => ({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload }],
        })),
      ],
    },
  });
}

// Sends a branching follow-up MessageNode as a free-form message — safe because
// the button tap that triggered this just reopened the 24-hour session window,
// so (unlike the entry node) this never needs template approval. variableValues
// resolves any {{n}} tokens in the node's bodyText, same positional convention
// as the entry template.
async function sendMessageNodeFollowUp(to, node, variableValues = []) {
  let bodyText = node.bodyText;
  variableValues.forEach((val, i) => { bodyText = bodyText.split(`{{${i + 1}}}`).join(String(val)); });

  if (!node.buttons.length) {
    return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: bodyText } });
  }

  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: node.buttons.map(b => ({
          type: 'reply',
          reply: { id: `msgnode_${node._id}_${b.position}`, title: b.label },
        })),
      },
    },
  });
}

// booking_no_show routes via serviceId/bookingId (not flowId/enrollmentId like the
// other 3) so the webhook can call handleRebookRequest directly — the originating
// FlowEnrollment is instead recovered via wamid correlation on the button tap.
async function sendNoShowTemplate(to, customerName, serviceName, serviceId, bookingId) {
  await ensureTemplateExists(NO_SHOW_TEMPLATE, createNoShowTemplate);
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     NO_SHOW_TEMPLATE,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'Valued Customer' },
            { type: 'text', text: serviceName || 'your appointment' },
          ],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `flownoshow_${serviceId}_${bookingId}` }],
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
    // Opt Out always sits below the shop/book action — same order on every
    // promo send, matching the merchant's explicit ask.
    action: { buttons: [
      { type: 'reply', reply: { id: `promo_${promotion._id}`, title: cta } },
      { type: 'reply', reply: { id: `optout_${promotion._id}`, title: 'Opt Out' } },
    ] },
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
      action: { buttons: [
        { type: 'reply', reply: { id: `promo_${promotion._id}`, title: 'Shop Now! 💎' } },
        { type: 'reply', reply: { id: `optout_${promotion._id}`, title: 'Opt Out' } },
      ] },
    },
    // No button in the plain-text fallback (WhatsApp text messages can't carry
    // buttons) — STOP already works as the text-equivalent opt-out.
    textFallback: bodyText + '\n\nReply *SHOP* to browse, or *STOP* to opt out.',
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
  createNoShowTemplate,
  createOtpTemplate,
  createInviteTemplate,
  createConsentRequestTemplate,
  createTemplate,
  deleteTemplate,
  sendPromoTemplate,
  sendLoyaltyTemplate,
  sendWinbackTemplate,
  sendPostPurchaseTemplate,
  sendPointsNudgeTemplate,
  sendNoShowTemplate,
  sendOtpTemplate,
  sendInviteTemplate,
  sendConsentRequestTemplate,
  // Branching
  sendCustomFlowTemplate,
  sendMessageNodeFollowUp,
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
  NO_SHOW_TEMPLATE,
  CONSENT_REQUEST_TEMPLATE,
  // Body copy (for preview rendering — see shared/operations.js#previewFlowMessage)
  WINBACK_BODY,
  POST_PURCHASE_BODY,
  POINTS_NUDGE_BODY,
  NO_SHOW_BODY,
};
