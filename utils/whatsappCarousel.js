// WhatsApp native Carousel Template messages — a horizontally-swipeable set of
// cards in ONE message, as opposed to the existing per-item separate-message
// flow (utils/whatsapp.js#sendProductCarousel/sendProductCards).
//
// Kept in its own file, isolated from utils/whatsapp.js's send-loop logic on
// purpose: an earlier attempt at this exact feature tried
// `interactive.type:'carousel'` (see the surviving warning at
// utils/whatsapp.js:771-774) — that type does not exist for WhatsApp's
// session/interactive messages and Meta silently mishandled it. The real
// mechanism is different: a CAROUSEL *template* component, sent via
// `type:"template"`, verified against Meta's current docs (2026-09):
//   - 2-10 cards; ALL cards in one template must share identical component
//     structure (same component types, same order).
//   - Each card: image/video header (required) + optional body (<=160 chars,
//     supports {{n}} variables) + up to 2 buttons.
//   - A template can only ever be sent with exactly the card count it was
//     approved with — hence one template per card count (2..10), created
//     on demand, same self-healing pattern as ensureTemplateExists below.
//   - Header images at template-creation time need a media "handle" from the
//     Resumable Upload API (POST /{app-id}/uploads -> POST upload:<id>),
//     which is a different upload flow from the regular /{phone-id}/media
//     endpoint already used for real sends (uploadMediaFromUrl, reused as-is
//     below).
//
// This file freely reuses the existing, already-proven token/WABA/media-send
// plumbing from ./whatsapp (waPost, getWabaId, getTemplate, uploadMediaFromUrl)
// via plain require — those are stable, generic infra that the rest of the app
// already depends on and this file never modifies a line of. Only the
// carousel-shaped template/message construction below is new.

const axios = require('axios');
const mime  = require('mime-types');
const tokenManager    = require('./tokenManager');
const { money }       = require('./currency');
const { getCurrency } = require('./settingsCache');

const WA_BASE  = 'https://graph.facebook.com/v25.0';
const WA_APP_ID = process.env.WA_APP_ID;

function carouselTemplateName(cardCount) {
  return `waflow_carousel_${cardCount}`;
}

// ── Resumable Upload API — template-creation example images only ──────────────
// (Send-time card images use the regular Media API via uploadMediaFromUrl,
// imported from ./whatsapp below — different endpoint, different purpose.)
async function uploadResumableMedia(imageUrl) {
  if (!WA_APP_ID) throw new Error('WA_APP_ID not set — required to upload carousel template example images');

  const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const buffer      = Buffer.from(imgRes.data);
  const contentType = imgRes.headers['content-type'] || 'image/jpeg';

  const startRes = await axios.post(`${WA_BASE}/${WA_APP_ID}/uploads`, null, {
    params: {
      file_name:    `carousel-example.${mime.extension(contentType) || 'jpg'}`,
      file_length:  buffer.length,
      file_type:    contentType,
      access_token: tokenManager.getToken(),
    },
  });
  const sessionId = startRes.data.id; // "upload:<session-id>"

  const uploadRes = await axios.post(`${WA_BASE}/${sessionId}`, buffer, {
    headers: {
      Authorization:  `OAuth ${tokenManager.getToken()}`,
      file_offset:    '0',
      'Content-Type': 'application/octet-stream',
    },
  });
  return uploadRes.data.h; // header_handle value
}

// Every card in a carousel template must have the identical component shape,
// so this always builds HEADER(image) + BODY({{1}}) + BUTTONS(1 quick reply).
// Button label is fixed at template-creation time (can't vary per send), so
// it stays a single generic word that reads correctly whether the card is a
// product, a service, or a points redemption.
async function createCarouselTemplate(cardCount, exampleImageUrls) {
  const { getWabaId } = require('./whatsapp');
  const wabaId = await getWabaId();
  const name   = carouselTemplateName(cardCount);

  const handles = [];
  for (let i = 0; i < cardCount; i++) {
    const url = exampleImageUrls[Math.min(i, exampleImageUrls.length - 1)];
    handles.push(await uploadResumableMedia(url));
  }

  const cards = handles.map(handle => ({
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } },
      // A body that's ONLY a variable ('{{1}}', confirmed live via a direct
      // create-template call: Meta rejected it with error_subcode 2388293,
      // "Parameters words ratio exceeds limit" — its anti-spam heuristic on
      // variable-to-word ratio) gets flatly rejected. Real static wrapper text
      // around the variable keeps the ratio well under what this account's
      // other already-approved templates use (~30%, e.g. createPromoTemplate's
      // body). Also needs an `example` for the {{n}}, same DEFECT-05/06 lesson
      // already learned the hard way in ./whatsapp.js's bodyComponentWithExample.
      // Single \n, not \n\n — confirmed live via error 132018 ("Hydrated body
      // cannot contain more than 2 line breaks"): whatever line breaks the
      // {{1}} value itself contains count against this same template-wide
      // budget, not a separate one. Doesn't apply retroactively to an
      // already-approved template (only the send-side fix does, see
      // buildCarouselSendComponents below) — this is a safety margin for the
      // next card-count template this app creates for the first time.
      { type: 'BODY', text: '{{1}}\nTap below to add this to your cart.', example: { body_text: [['Sample Item — $19.99']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'View' }] },
    ],
  }));

  const res = await axios.post(
    `${WA_BASE}/${wabaId}/message_templates`,
    {
      name,
      language: 'en',
      category: 'MARKETING',
      // Confirmed live via a direct create-template call: Meta rejects any
      // FOOTER (or HEADER) on the main carousel bubble outright
      // (error_subcode 2388208, "Carousel main message bubble cannot have a
      // header or footer") — unlike every other template in this app. The
      // opt-out notice folds into the body text instead, since there's
      // nowhere else on a carousel template to put it.
      components: [
        { type: 'BODY', text: 'Hi {{1}}! ✨ *{{2}}* — swipe to explore, tap a card to continue →\n\nReply STOP to unsubscribe.', example: { body_text: [['Sarah', 'Summer Sale']] } },
        { type: 'CAROUSEL', cards },
      ],
    },
    { headers: { Authorization: `Bearer ${tokenManager.getToken()}`, 'Content-Type': 'application/json' } },
  );
  return res.data;
}

// Self-healing "create once" pattern, mirroring ensureTemplateExists in
// ./whatsapp.js, but with its own local cache — never touches that file's
// knownTemplates Set.
const knownCarouselTemplates = new Set();

async function ensureCarouselTemplateExists(cardCount, exampleImageUrls) {
  const name = carouselTemplateName(cardCount);
  if (knownCarouselTemplates.has(name)) return;
  const { getTemplate } = require('./whatsapp');
  try {
    if (await getTemplate(name)) { knownCarouselTemplates.add(name); return; }
  } catch (_) { /* listTemplates failed — fall through and attempt creation anyway */ }
  try {
    await createCarouselTemplate(cardCount, exampleImageUrls);
    knownCarouselTemplates.add(name);
  } catch (_) {
    // Might already exist (race with a concurrent send) or genuinely failed —
    // don't cache a failure; the next call (preview re-open or actual send)
    // retries fresh, same reasoning as ensureTemplateExists.
  }
}

// Builds the send-time `carousel` component's cards — one per item, each with
// its real image (via the existing, already-proven Media API upload), a
// formatted name+price/points body line, and one button whose payload is
// supplied by the caller (products reuse the existing cart_<id> handler
// unchanged; services use a new carouselsvc_ prefix — this file has no
// opinion on which, it just calls buttonIdFor(item)).
async function buildCarouselSendComponents(items, promotion, buttonIdFor) {
  const { uploadMediaFromUrl } = require('./whatsapp');
  const isPoints  = promotion.customerType === 'points';
  const disc      = promotion.discountPercent || 0;
  const currency  = isPoints ? null : await getCurrency();

  const cards = [];
  for (let i = 0; i < items.length; i++) {
    const item    = items[i];
    const mediaId = await uploadMediaFromUrl(item.images[0]);
    const priceStr = isPoints
      ? `💎 ${promotion.pointsPrice} pts`
      : `💰 ${money(item.basePrice * (1 - disc / 100), currency)}${disc ? ` (${disc}% OFF)` : ''}`;

    cards.push({
      card_index: i,
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] },
        // Single line, no \n — confirmed live via error 132018 ("Hydrated
        // body cannot contain more than 2 line breaks"): the card BODY
        // template text already has its own line break(s), and this
        // variable's content adds to that same hydrated total, not a
        // separate budget. A line break here pushed an already-approved
        // template over the limit at send time, with no way to know until
        // an actual send was attempted (Meta doesn't validate this at
        // template-creation time, only when the variables are filled in).
        { type: 'body', parameters: [{ type: 'text', text: `*${item.name}* — ${priceStr}` }] },
        // index is a NUMBER here (not the '0' string convention used by every
        // other template button elsewhere in this codebase) — Meta's documented
        // carousel send-payload example uses numeric card-button indexes.
        { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: buttonIdFor(item) }] },
      ],
    });
  }
  return cards;
}

async function sendCarouselTemplate(to, cardCount, bodyParams, cardComponents) {
  const { waPost } = require('./whatsapp');
  return waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     carouselTemplateName(cardCount),
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) },
        { type: 'carousel', cards: cardComponents },
      ],
    },
  });
}

module.exports = {
  carouselTemplateName,
  uploadResumableMedia,
  createCarouselTemplate,
  ensureCarouselTemplateExists,
  buildCarouselSendComponents,
  sendCarouselTemplate,
};
