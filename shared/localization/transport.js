'use strict';
// The ONLY place the localisation feature talks to WhatsApp. Thin wrappers
// over the existing utils/whatsapp.js#waPost (imported lazily, read-only), so
//   * unit tests mock one module, and
//   * LOCALIZATION_SEND_MODE=dry_run makes local verification safe: nothing is
//     sent to Meta, the would-be payload is logged and kept in a small ring
//     buffer. Production never sets it.
const MAX_BUFFER = 200;
const dryRuns = [];

function isDryRun() {
  return process.env.LOCALIZATION_SEND_MODE === 'dry_run';
}

function lastDryRuns() { return dryRuns.slice(); }
function clearDryRuns() { dryRuns.length = 0; }

async function send(payload, label) {
  if (isDryRun()) {
    dryRuns.push({ at: new Date().toISOString(), label, payload });
    if (dryRuns.length > MAX_BUFFER) dryRuns.shift();
    console.log(`[localization] DRY RUN ${label} ->`, payload.to);
    return { dryRun: true, messages: [{ id: `dryrun.${dryRuns.length}.${Math.random().toString(36).slice(2, 8)}` }] };
  }
  const { waPost } = require('../../utils/whatsapp');
  // New-code sends are explicit about their language: the outbound localiser (journey replies, outbound.js) must never re-handle them.
  let guard = null;
  try { guard = require('./outbound').withoutLocalization; } catch (_) { guard = null; }
  return guard ? guard(() => waPost(payload)) : waPost(payload);
}

function sendText(to, body) {
  return send({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }, 'text');
}

// components: Meta "template.components" array (body parameters, button payloads).
function sendTemplate(to, { name, languageCode, components }) {
  return send({
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name, language: { code: languageCode }, ...(components && components.length ? { components } : {}) },
  }, 'template');
}

// buttons: [{ id, title }] (max 3, title max 20 chars — Meta interactive reply buttons).
function sendButtons(to, { body, buttons }) {
  return send({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  }, 'buttons');
}

// Tolerant wamid extraction: waPost may return the Graph payload or an axios-style envelope.
function extractWamid(result) {
  if (!result) return undefined;
  const body = result.data && result.data.messages ? result.data : result;
  return body && body.messages && body.messages[0] && body.messages[0].id;
}

module.exports = { isDryRun, lastDryRuns, clearDryRuns, sendText, sendTemplate, sendButtons, extractWamid };
