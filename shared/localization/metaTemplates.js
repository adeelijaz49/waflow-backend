'use strict';
// Everything about WhatsApp message TEMPLATES that touches Meta's wire format
// (spec §3.2: "Submit Arabic variants to Meta with language code ar"; §8: build
// the submit-for-approval path early):
//   * buildTemplateName      a DISTINCT Meta name per workspace/template/language/revision
//   * buildSubmissionPayload the Graph "create template" body (positional {{n}} + examples,
//                            footer, quick-reply and URL buttons)
//   * buildSendComponents    the `components` array of a template SEND (parameters + button payloads)
//   * createMetaClient       the only Graph client of this feature: create, GET /{id}, list-by-name,
//                            delta sweep (?since=) and the slot usage summary.
//                            There is NO delete method on purpose (a deleted name cannot be reused
//                            for a long while and Meta deletes by name = every language).
// Live-Meta findings applied here (META-REALITY): no direction marks in submitted text or examples
// (they are only ever added to what is DISPLAYED, or to send parameters when
// LOCALIZATION_WRAP_PARAM_LRM=1); the 10 Graph statuses map to themselves and anything unknown to the
// non-sendable ERROR; `name` filters are substring matches, so callers compare name AND language.
// Why distinct names: the existing code looks templates up, caches and deletes
// them by NAME only (utils/whatsapp.js getTemplate/ensureTemplateExists/
// deleteTemplate, audit R2 §5), so two languages under one name — or a new
// revision under an old name — would let those functions read or destroy the
// wrong one. Names are `wf_<ws6>_<key>_<en|ar|bi>_v<revision>` and never recycled.
// utils/whatsapp.js and utils/tokenManager.js are required LAZILY inside the
// client factory so unit tests (which inject fakes) never load them or touch the network.
const { META_LANGUAGE, QUICK_REPLY_ROLES, validateTemplateName } = require('./metaConstraints');
const { FIELD_RE, MissingMergeFieldError, renderMessageSafe, sampleValues, toPositional } = require('./mergeFields');
const { countLetters } = require('./arabicText');

// Same version the rest of the backend talks to (copy of utils/whatsapp.js WA_BASE, which is not exported).
const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const REQUEST_TIMEOUT_MS = 20000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_PAYLOAD_CHARS = 256; // Meta: a quick-reply payload is at most 256 characters
const LANGUAGE_SLUG = Object.freeze({ en: 'en', ar: 'ar', bilingual: 'bi' });
const UNREACHABLE_MESSAGE = 'Could not reach WhatsApp (Meta). Please try again.';

// Statuses Graph reports for a template (verified live, META-REALITY §1). FLAGGED is
// NOT one of them (it is a webhook event). An unknown value maps to the non-sendable
// ERROR and the caller keeps the raw text: a Mongoose enum throws on save, which
// would stop the poller on the first surprise.
const KNOWN_STATUSES = Object.freeze(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL',
  'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED']);
const TEMPLATE_FIELDS = 'name,status,category,previous_category,language,rejected_reason,quality_score,last_updated_time';
const SWEEP_FIELDS = `id,${TEMPLATE_FIELDS}`; // never `components`: it makes every sweep row huge
const MAX_SWEEP_PAGES = 20;
const SWEEP_OVERLAP_SECONDS = 5 * 60; // callers re-read a few minutes before the last sweep (clock skew, late edits)
// Direction marks and embedded-direction controls: none may be submitted (Meta's own Arabic templates carry none).
const DIRECTION_MARKS_RE = /[\u{200E}\u{200F}\u{061C}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const stripMarks = (text) => String(text).replace(DIRECTION_MARKS_RE, '');

class MetaNotConfiguredError extends Error {
  constructor(message) {
    super(message || 'WhatsApp is not connected for this platform');
    this.name = 'MetaNotConfiguredError';
  }
}

// An upstream failure with the sanitised { code?, subcode?, message } the UI may show.
class MetaApiError extends Error {
  constructor(metaError, { httpStatus } = {}) {
    super((metaError && metaError.message) || 'WhatsApp (Meta) request failed');
    this.name = 'MetaApiError';
    this.metaError = metaError || { message: this.message };
    this.httpStatus = httpStatus;
  }
}

// A template send that cannot be built safely (missing parameter value, missing button payload).
class SendComponentsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SendComponentsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ── names ─────────────────────────────────────────────────────────────────
function asciiSlug(value) {
  return String(value === undefined || value === null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u{0300}-\u{036F}]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function shortId(seed) {
  const hex = String(seed === undefined || seed === null ? '' : seed).replace(/[^a-f0-9]/gi, '').slice(-8);
  const n = hex ? parseInt(hex, 16) : Math.floor(Math.random() * 0xffffffff);
  return n.toString(36);
}

// wf_<last 6 hex of workspace id>_<key slug>_<en|ar|bi>_v<revision>
// `key` may be Arabic (templates derived from an Arabic name): its ASCII slug is
// then empty and a short base36 id derived from `fallbackId` (the template id) stands in.
function buildTemplateName({ workspaceId, key, language, revision, fallbackId }) {
  const langSlug = LANGUAGE_SLUG[language];
  if (!langSlug) throw new Error(`Unsupported template language: ${language}`);
  if (!Number.isInteger(revision) || revision < 1) throw new Error('revision must be a positive integer');
  const ws6 = String(workspaceId === undefined || workspaceId === null ? '' : workspaceId).replace(/[^a-f0-9]/gi, '').slice(-6).toLowerCase().padStart(6, '0');
  const slug = asciiSlug(key).slice(0, 40).replace(/_+$/g, '') || shortId(fallbackId);
  const name = `wf_${ws6}_${slug}_${langSlug}_v${revision}`;
  if (!validateTemplateName(name).ok) throw new Error('Could not build a valid Meta template name');
  return name;
}

// The language code Meta gets: en -> en, ar -> ar, bilingual -> the FIRST language.
function metaLanguageFor(variant) {
  const v = variant || {};
  if (v.language === 'bilingual') return v.bilingualOrder === 'en_first' ? META_LANGUAGE.bilingual_en_first : META_LANGUAGE.bilingual_ar_first;
  return META_LANGUAGE[v.language] || null;
}

// ── submission payload ────────────────────────────────────────────────────
// variant: { language, header?, body, footer?, bilingualOrder?, buttons?: [{ role, text, url? }] }
// Quick replies must precede URL buttons (Meta groups them); callers validate
// first (metaConstraints.validateVariant) — this throws rather than emit a payload Meta would reject.
function buildSubmissionPayload({ name, variant, category = 'MARKETING' }) {
  const v = variant || {};
  const language = metaLanguageFor(v);
  if (!language) throw new Error(`Unsupported variant language: ${v.language}`);
  if (!validateTemplateName(name).ok) throw new Error('Invalid Meta template name');
  if (category !== 'MARKETING' && category !== 'UTILITY') throw new Error(`Unsupported category: ${category}`);
  const sampleLanguage = language; // examples in the language the template is submitted under
  const components = [];

  const header = toPositional(typeof v.header === 'string' ? stripMarks(v.header) : '');
  if (header.text.trim()) {
    const component = { type: 'HEADER', format: 'TEXT', text: header.text };
    if (header.params.length) component.example = { header_text: sampleValues(header.params, sampleLanguage) };
    components.push(component);
  }

  const body = toPositional(typeof v.body === 'string' ? stripMarks(v.body) : '');
  if (!body.text.trim()) throw new Error('A template body is required');
  const bodyComponent = { type: 'BODY', text: body.text };
  if (body.params.length) bodyComponent.example = { body_text: [sampleValues(body.params, sampleLanguage)] };
  components.push(bodyComponent);

  if (typeof v.footer === 'string' && stripMarks(v.footer).trim()) components.push({ type: 'FOOTER', text: stripMarks(v.footer).trim() });

  const buttons = Array.isArray(v.buttons) ? v.buttons : [];
  if (buttons.length) {
    let sawUrl = false;
    const wire = buttons.map((b) => {
      if (b && b.role === 'url') {
        sawUrl = true;
        return { type: 'URL', text: stripMarks(b.text), url: String(b.url) };
      }
      if (!b || !QUICK_REPLY_ROLES.includes(b.role)) throw new Error('Unsupported button role');
      if (sawUrl) throw new Error('Quick-reply buttons must come before URL buttons');
      return { type: 'QUICK_REPLY', text: stripMarks(b.text) };
    });
    components.push({ type: 'BUTTONS', buttons: wire });
  }
  return { name, language, category, components };
}

// ── send components ───────────────────────────────────────────────────────
// Language of every {field} occurrence in `text`, in order. English/Arabic
// variants are one language; a bilingual body is two paragraphs, each with the
// language of its own script (a paragraph with no letters, e.g. only {link},
// takes the variant's first language).
function occurrenceLanguages(text, language, bilingualOrder) {
  const source = String(text === undefined || text === null ? '' : text);
  const total = Array.from(source.matchAll(FIELD_RE)).length;
  if (language !== 'bilingual') return new Array(total).fill(language === 'ar' ? 'ar' : 'en');
  const first = bilingualOrder === 'en_first' ? 'en' : 'ar';
  const out = [];
  for (const paragraph of source.split(/\r?\n[ \t]*\r?\n/)) {
    const count = Array.from(paragraph.matchAll(FIELD_RE)).length;
    const letters = countLetters(paragraph.replace(FIELD_RE, ' ').replace(/https?:\/\/\S+/gi, ' '));
    const lang = !letters.arabic && !letters.latin ? first : (letters.arabic > letters.latin ? 'ar' : 'en');
    for (let i = 0; i < count; i += 1) out.push(lang);
  }
  return out;
}

// Replace {fields} using the per-occurrence languages (Latin/number values get
// direction marks only inside Arabic paragraphs). -> { text, missing }
function renderWithLanguages(text, values, languages) {
  let i = 0;
  const missing = [];
  const out = String(text === undefined || text === null ? '' : text).replace(FIELD_RE, (match, name) => {
    const language = languages[i] || 'en';
    i += 1;
    const res = renderMessageSafe(match, values, { language });
    for (const m of res.missing) if (!missing.includes(m)) missing.push(m);
    return res.text;
  });
  return { text: out, missing };
}

function firstLanguageOf(variant) {
  if (variant.language === 'bilingual') return variant.bilingualOrder === 'en_first' ? 'en' : 'ar';
  return variant.language === 'ar' ? 'ar' : 'en';
}

// Direction marks around Latin/number PARAMETER values are an unproven experiment (Meta's own
// Arabic templates use none): off unless LOCALIZATION_WRAP_PARAM_LRM=1. URLs are never wrapped.
const wrapParamValues = () => process.env.LOCALIZATION_WRAP_PARAM_LRM === '1';

function textParameters(text, values, languages, missing) {
  const { params } = toPositional(text);
  return params.map((field, i) => {
    const res = renderMessageSafe(`{${field}}`, values, { language: languages[i] || 'en', protect: wrapParamValues() });
    if (res.missing.length) { if (!missing.includes(field)) missing.push(field); return null; }
    return { type: 'text', text: res.text };
  });
}

// Quick-reply payloads come from `buttonPayloads`:
//   * an array aligned with variant.buttons (the shape sendCustomFlowTemplate uses), or
//   * an object keyed by button index ('0') and/or by role ({ opt_out: 'optout_<id>', ... });
//     a value may also be a function (button, index) => payload.
function payloadFor(buttonPayloads, button, index) {
  if (!buttonPayloads || typeof buttonPayloads !== 'object') return undefined;
  let value;
  if (Array.isArray(buttonPayloads)) value = buttonPayloads[index];
  else if (Object.prototype.hasOwnProperty.call(buttonPayloads, String(index))) value = buttonPayloads[String(index)];
  else if (Object.prototype.hasOwnProperty.call(buttonPayloads, button.role)) value = buttonPayloads[button.role];
  return typeof value === 'function' ? value(button, index) : value;
}

// Meta `components` for sending an approved variant. Pure. Throws
// MissingMergeFieldError (never sends a blank parameter) or SendComponentsError
// (a quick reply without a usable payload would be a dead button — and a dead
// opt-out button is a compliance failure).
//   values: { fieldName: value } — sanitised for WhatsApp, Latin/number values
//           wrapped in direction marks inside Arabic text (mergeFields.renderMessageSafe)
function buildSendComponents({ variant, values, buttonPayloads } = {}) {
  const v = variant || {};
  // Own properties only: a field named like an Object.prototype member must never resolve to an inherited value.
  const given = Object.assign(Object.create(null), values && typeof values === 'object' ? values : {});
  const components = [];
  const missing = [];
  const headerText = typeof v.header === 'string' ? v.header : '';
  const bodyText = typeof v.body === 'string' ? v.body : '';
  const firstLang = firstLanguageOf(v);

  const headerParams = textParameters(headerText, given, occurrenceLanguages(headerText, firstLang), missing);
  const bodyParams = textParameters(bodyText, given, occurrenceLanguages(bodyText, v.language, v.bilingualOrder), missing);
  if (missing.length) throw new MissingMergeFieldError(missing);
  if (headerParams.length) components.push({ type: 'header', parameters: headerParams });
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });

  (Array.isArray(v.buttons) ? v.buttons : []).forEach((button, index) => {
    if (!button || button.role === 'url') return; // static URL buttons carry no parameter
    const payload = payloadFor(buttonPayloads, button, index);
    if (typeof payload !== 'string' || !payload) {
      throw new SendComponentsError('BUTTON_PAYLOAD_MISSING', `Button ${index} (${button.role}) needs a payload`, { button: index, role: button.role });
    }
    if (Array.from(payload).length > MAX_PAYLOAD_CHARS) {
      throw new SendComponentsError('BUTTON_PAYLOAD_TOO_LONG', `Button ${index} payload exceeds ${MAX_PAYLOAD_CHARS} characters`, { button: index, role: button.role });
    }
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] });
  });
  return components;
}

// ── Meta responses ────────────────────────────────────────────────────────
const statusKey = (status) => String(status === undefined || status === null ? '' : status).trim().toUpperCase();

function isKnownMetaStatus(status) {
  return KNOWN_STATUSES.includes(statusKey(status));
}

// Graph status -> our status: a known one maps to itself, an unknown non-empty one to the
// non-sendable ERROR (the raw text is kept by the caller), nothing at all to null.
function mapMetaStatus(status) {
  const key = statusKey(status);
  if (!key) return null;
  return KNOWN_STATUSES.includes(key) ? key : 'ERROR';
}

// Graph's quality_score is { score: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN', date? } (or a bare string).
function cleanQualityScore(raw) {
  const value = raw && typeof raw === 'object' ? raw.score : raw;
  const text = cleanText(value, 20).toUpperCase();
  return text || null;
}

const SECRET_PATTERNS = [/access_token=[^&\s"']+/gi, /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, /\bEAA[A-Za-z0-9]{20,}\b/g];

// Upstream text is shown to merchants: strip control/bidi characters, secrets
// and excess length. Never returns an object, stack or request config.
function cleanText(raw, max = 300) {
  if (raw === undefined || raw === null || typeof raw === 'object') return '';
  let s = String(raw);
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
  s = s
    .replace(/[\u{0000}-\u{001F}\u{007F}-\u{009F}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, max).join('');
}

// axios error -> { code?, subcode?, message }  (the Graph `error` object, sanitised)
function sanitizeMetaError(err) {
  const body = err && err.response && err.response.data;
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  if (!e) return { message: UNREACHABLE_MESSAGE };
  const out = {};
  const code = Number(e.code);
  if (e.code !== undefined && e.code !== null && Number.isFinite(code)) out.code = code;
  const subcode = Number(e.error_subcode);
  if (e.error_subcode !== undefined && e.error_subcode !== null && Number.isFinite(subcode)) out.subcode = subcode;
  out.message = cleanText(e.error_user_msg) || cleanText(e.error_user_title) || cleanText(e.message) || 'WhatsApp (Meta) rejected the request';
  return out;
}

// "NONE" is Meta's way of saying "not rejected".
function cleanRejectedReason(reason) {
  const text = cleanText(reason, 120);
  return !text || /^none$/i.test(text) ? null : text;
}

function toMetaError(err) {
  if (err instanceof MetaNotConfiguredError || err instanceof MetaApiError) return err;
  return new MetaApiError(sanitizeMetaError(err), { httpStatus: err && err.response && err.response.status });
}

// Date | ISO string | unix seconds -> unix seconds minus the overlap; undefined when not a usable time.
function toUnixSeconds(since) {
  if (since === undefined || since === null || since === '') return undefined;
  const ms = typeof since === 'number' && since < 1e11 ? since * 1000 : new Date(since).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.max(0, Math.floor(ms / 1000) - SWEEP_OVERLAP_SECONDS) : undefined;
}

function sameOrigin(candidate, origin) {
  try { return new URL(candidate).origin === origin; } catch (err) { return false; }
}

// ── Graph client ──────────────────────────────────────────────────────────
// deps (all optional; defaults are the real thing, loaded lazily):
//   http        axios-like { get, post }
//   getToken    () => token             (default utils/tokenManager.getToken)
//   getWabaId   async () => wabaId      (default utils/whatsapp.getWabaId)
//   baseUrl, timeoutMs
function createMetaClient(deps = {}) {
  let http = deps.http;
  const client = () => { if (!http) http = require('axios'); return http; };
  const getToken = deps.getToken || (() => require('../../utils/tokenManager').getToken());
  const getWabaId = deps.getWabaId || (() => require('../../utils/whatsapp').getWabaId());
  const base = String(deps.baseUrl || GRAPH_BASE).replace(/\/+$/, '');
  const timeout = deps.timeoutMs || REQUEST_TIMEOUT_MS;

  // Resolves credentials or throws MetaNotConfiguredError — before anything is
  // claimed or sent, so "not configured" never burns a template revision.
  // Dry-run mode (LOCALIZATION_SEND_MODE=dry_run, local verification) must never
  // reach Graph even if a caller forgets to check it first.
  async function context() {
    if (process.env.LOCALIZATION_SEND_MODE === 'dry_run') throw new MetaNotConfiguredError('Dry-run mode: Meta is not contacted');
    let token = '';
    try { token = await getToken(); } catch (err) { token = ''; }
    if (!token || typeof token !== 'string') throw new MetaNotConfiguredError('WhatsApp is not connected: no access token is configured');
    let wabaId = null;
    try { wabaId = await getWabaId(); } catch (err) { wabaId = null; }
    if (!wabaId || !/^[A-Za-z0-9_-]{1,64}$/.test(String(wabaId))) throw new MetaNotConfiguredError('WhatsApp Business Account id is not configured');
    return { token, wabaId: String(wabaId) };
  }

  const headersFor = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  async function assertConfigured() {
    await context();
    return true;
  }

  // POST {base}/{waba}/message_templates -> { id, status, category }
  async function submitTemplate(payload) {
    const { token, wabaId } = await context();
    try {
      const res = await client().post(`${base}/${wabaId}/message_templates`, payload, { headers: headersFor(token), timeout });
      const data = (res && res.data) || {};
      return {
        id: data.id ? String(data.id) : null,
        status: data.status ? String(data.status).toUpperCase() : null,
        category: data.category ? String(data.category).toUpperCase() : null,
      };
    } catch (err) {
      throw toMetaError(err);
    }
  }

  // Every template of the WABA whose name matches, across languages (Meta may
  // do a partial match, so callers compare name AND language themselves).
  async function listTemplatesByName(name) {
    const { token, wabaId } = await context();
    const origin = new URL(base).origin;
    const rows = [];
    let url = `${base}/${wabaId}/message_templates`;
    let params = { name, fields: SWEEP_FIELDS, limit: PAGE_SIZE };
    try {
      for (let page = 0; url && page < MAX_PAGES; page += 1) {
        const res = await client().get(url, { headers: headersFor(token), params, timeout });
        const body = (res && res.data) || {};
        if (Array.isArray(body.data)) rows.push(...body.data);
        const next = body.paging && typeof body.paging.next === 'string' ? body.paging.next : null;
        // Only ever follow a paging link back to Graph itself (the link carries credentials).
        url = next && sameOrigin(next, origin) ? next : null;
        params = undefined;
      }
    } catch (err) {
      throw toMetaError(err);
    }
    return rows;
  }

  // GET /{template id} — the cheap, exact poll (no substring matching). -> the row, or null when Graph does not know the id.
  async function getTemplateById(id) {
    if ((typeof id !== 'string' && typeof id !== 'number') || !/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new MetaApiError({ message: 'Invalid template id' });
    const { token } = await context();
    try {
      const res = await client().get(`${base}/${id}`, { headers: headersFor(token), params: { fields: TEMPLATE_FIELDS }, timeout });
      const data = res && res.data;
      return data && typeof data === 'object' ? { id: String(id), ...data } : null;
    } catch (err) {
      const e = toMetaError(err);
      if (e instanceof MetaApiError && e.httpStatus === 404) return null;
      throw e;
    }
  }

  // Delta sweep: every template of the WABA changed since `since` (Date | ISO string | unix seconds),
  // newest first, following paging.cursors.after. -> rows[]
  async function listTemplatesSince({ since } = {}) {
    const seconds = toUnixSeconds(since);
    const { token, wabaId } = await context();
    const rows = [];
    let after;
    try {
      for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
        const params = { fields: SWEEP_FIELDS, limit: PAGE_SIZE, ...(seconds ? { since: seconds } : {}), ...(after ? { after } : {}) };
        const res = await client().get(`${base}/${wabaId}/message_templates`, { headers: headersFor(token), params, timeout });
        const body = (res && res.data) || {};
        if (Array.isArray(body.data)) rows.push(...body.data);
        const cursor = body.paging && body.paging.cursors && body.paging.cursors.after;
        after = body.paging && body.paging.next && typeof cursor === 'string' && cursor ? cursor : undefined;
        if (!after) break;
      }
    } catch (err) {
      throw toMetaError(err);
    }
    return rows;
  }

  // How many template slots the WABA uses. -> { used, limit } (numbers or null)
  async function getUsage() {
    const { token, wabaId } = await context();
    try {
      const res = await client().get(`${base}/${wabaId}/message_templates`, {
        headers: headersFor(token), params: { summary: 'total_count,message_template_limit', fields: 'id', limit: 1 }, timeout,
      });
      const summary = (res && res.data && res.data.summary) || {};
      const num = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n) : null);
      return { used: num(summary.total_count), limit: num(summary.message_template_limit) };
    } catch (err) {
      throw toMetaError(err);
    }
  }

  return { assertConfigured, submitTemplate, listTemplatesByName, getTemplateById, listTemplatesSince, getUsage };
}

module.exports = {
  GRAPH_BASE, LANGUAGE_SLUG, MAX_PAYLOAD_CHARS,
  MetaApiError, MetaNotConfiguredError, SendComponentsError,
  asciiSlug, buildTemplateName, metaLanguageFor, buildSubmissionPayload,
  occurrenceLanguages, renderWithLanguages, firstLanguageOf, buildSendComponents,
  KNOWN_STATUSES, isKnownMetaStatus, mapMetaStatus, cleanQualityScore, cleanText, cleanRejectedReason, sanitizeMetaError, createMetaClient,
};
