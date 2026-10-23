'use strict';
// Meta Graph client for the onboarding flow (DB design 6.2; wire shapes: AU4 MOCK CONTRACT).
//
// - Credentials are an EXPLICIT argument of every call (the merchant access token). Nothing reads
//   tokenManager, process.env.WA_TOKEN or Workspace.whatsapp: the platform token can never be used here.
// - The merchant token travels in the Authorization header only, never in a URL. The code exchange
//   and debug_token use the app credentials as the protocol requires (metaConfig.DEBUG_TOKEN_AUTH).
// - The HTTP port (INTERFACES 0.2) resolves { status, data, headers } for EVERY HTTP status
//   (validateStatus: () => true) and rejects { code, message } on a network failure.
// - Failures become MetaGraphError { httpStatus, code, subcode, kind, appCode, retryable, fbtraceId }
//   with a SANITISED message (tokens, codes, PINs and long ids redacted). The client never logs.
// - Nothing is executed at require time (no env reads, no network, no timers).
const crypto = require('crypto');
const metaConfig = require('./metaConfig');
const metaErrors = require('./metaErrors');

const WABA_FIELDS_CORE = 'id,name,currency,business_verification_status,health_status';
const TEMPLATE_FIELDS = 'name,language,status,category,id,quality_score';
const MAX_PAGES = 20;
const ID_RE = /^[0-9A-Za-z_.-]{1,64}$/;

// ---- errors --------------------------------------------------------------------------------------------------------

/** A failed Graph call. `message` is sanitised; nothing here ever carries a token, code or PIN. */
class MetaGraphError extends Error {
  /**
   * @param {string} message
   * @param {{httpStatus?:number|null, code?:number|null, subcode?:number|null, kind?:string, appCode?:string, retryable?:boolean, fbtraceId?:string|null, networkCode?:string|null}} [o]
   */
  constructor(message, o = {}) {
    super(message);
    this.name = 'MetaGraphError';
    this.httpStatus = o.httpStatus === undefined ? null : o.httpStatus;
    this.code = o.code === undefined ? null : o.code;
    this.subcode = o.subcode === undefined ? null : o.subcode;
    this.kind = o.kind || 'unknown';
    this.appCode = o.appCode || 'META_ERROR';
    this.retryable = !!o.retryable;
    this.fbtraceId = o.fbtraceId || null;
    if (o.networkCode) this.networkCode = o.networkCode;
  }
}

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/**
 * Redact everything secret-like from text that may be shown or stored: the call's own secrets,
 * access_token= / Bearer values, EAA tokens, any 40+ char token-like run, any 9+ digit id/phone.
 * @param {*} text
 * @param {string[]} [secrets] exact strings to remove (token, code, pin, app secret)
 * @returns {string} at most 300 characters
 */
function sanitizeMessage(text, secrets = []) {
  let s = typeof text === 'string' ? text : (text === undefined || text === null || typeof text === 'object' ? '' : String(text));
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) s = s.split(secret).join('[redacted]');
  }
  s = s
    .replace(/(access_token|client_secret|input_token|appsecret_proof|code|pin)=[^&\s"']+/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=|-]+/gi, 'Bearer [redacted]')
    .replace(/\bEAA[A-Za-z0-9]{10,}\b/g, '[redacted]')
    .replace(/[A-Za-z0-9_|-]{40,}/g, '[redacted]')
    .replace(/\d{9,}/g, '[id]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, 300).join('');
}

function cleanTrace(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_+/=.-]{1,60}$/.test(v) ? v : null;
}

function errorFromResponse(res, secrets) {
  const status = typeof res.status === 'number' ? res.status : null;
  const body = res.data && typeof res.data === 'object' && res.data.error && typeof res.data.error === 'object' ? res.data.error : {};
  const code = toInt(body.code);
  const subcode = toInt(body.error_subcode !== undefined ? body.error_subcode : body.subcode);
  const c = metaErrors.classify({ httpStatus: status, code, subcode });
  const fallback = status ? `Graph request failed with HTTP ${status}` : 'Graph request failed';
  return new MetaGraphError(sanitizeMessage(body.message || fallback, secrets) || fallback, {
    httpStatus: status, code, subcode, kind: c.kind, appCode: c.appCode, retryable: c.retryable, fbtraceId: cleanTrace(body.fbtrace_id),
  });
}

function networkError(e, secrets) {
  const raw = e && typeof e.code === 'string' ? e.code : '';
  const networkCode = metaErrors.NETWORK_CODES.includes(raw) ? raw : 'ECONNRESET';
  return new MetaGraphError(sanitizeMessage(e && e.message ? e.message : 'network error', secrets) || 'network error', {
    kind: 'network', appCode: 'META_UNREACHABLE', retryable: true, networkCode,
  });
}

function invalid(message, kind = 'invalid') {
  return new MetaGraphError(message, { kind, appCode: kind === 'not_configured' ? 'META_NOT_CONFIGURED' : 'META_ERROR', retryable: false });
}

// ---- small helpers -------------------------------------------------------------------------------------------------

function pathId(id, label = 'id') {
  const s = typeof id === 'number' ? String(id) : id;
  if (typeof s !== 'string' || !ID_RE.test(s)) throw invalid(`Invalid ${label}`);
  return s;
}

function needToken(token) {
  if (typeof token !== 'string' || token.length < 10) throw invalid('A merchant access token is required');
  return token;
}

function fieldList(fields, fallback) {
  if (Array.isArray(fields)) return fields.map((f) => String(f).trim()).filter(Boolean).join(',') || fallback;
  if (typeof fields === 'string' && fields.trim()) return fields.split(',').map((f) => f.trim()).filter(Boolean).join(',');
  return fallback;
}

/** True when a 400 code 100 names one of the requested fields (a field Meta does not expose to this app). */
function fieldWasRejected(err, fieldsCsv) {
  if (!(err instanceof MetaGraphError) || err.httpStatus !== 400 || err.code !== 100 || err.subcode === 33) return false;
  const msg = String(err.message || '').toLowerCase();
  if (!/field/.test(msg)) return false;
  return fieldsCsv.split(',').some((f) => f && new RegExp(`(^|[^a-z0-9_])${f.toLowerCase().replace(/[^a-z0-9_]/g, '')}([^a-z0-9_]|$)`).test(msg));
}

function sameOrigin(candidate, origin) {
  try { const u = new URL(candidate); return u.protocol === 'https:' && u.origin === origin; } catch (_) { return false; }
}

function last4(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

function withHidden(arr, props) {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(arr, k, { value: v, enumerable: false, configurable: true, writable: true });
  return arr;
}

// ---- normalisers (raw Graph snake_case fields are kept AND camelCase aliases added) ------------------------------

function normalisePhone(raw, fieldsDegraded) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return Object.assign({}, r, {
    id: r.id === undefined || r.id === null ? null : String(r.id),
    displayPhoneNumber: r.display_phone_number || null,
    last4: last4(r.display_phone_number),
    verifiedName: r.verified_name || null,
    nameStatus: r.name_status || null,
    newDisplayName: r.new_display_name || null,
    newNameStatus: r.new_name_status || null,
    qualityRating: r.quality_rating || null,
    codeVerificationStatus: r.code_verification_status || null,
    status: r.status || null,
    platformType: r.platform_type || null,
    isOnBizApp: typeof r.is_on_biz_app === 'boolean' ? r.is_on_biz_app : null,
    messagingLimit: r.whatsapp_business_manager_messaging_limit !== undefined ? r.whatsapp_business_manager_messaging_limit : (r.messaging_limit_tier !== undefined ? r.messaging_limit_tier : null),
    throughput: r.throughput || null,
    fieldsDegraded: !!fieldsDegraded,
  });
}

function normaliseHealth(h) {
  if (!h || typeof h !== 'object') return null;
  const entities = Array.isArray(h.entities) ? h.entities.slice(0, 20).map((e) => ({
    entityType: e && e.entity_type ? String(e.entity_type) : null,
    id: e && e.id !== undefined ? String(e.id) : null,
    canSend: e && e.can_send_message ? String(e.can_send_message) : null,
    errors: Array.isArray(e && e.errors) ? e.errors.slice(0, 5).map((x) => ({
      code: toInt(x && x.error_code),
      description: sanitizeMessage(x && x.error_description),
      solution: sanitizeMessage(x && x.possible_solution),
    })) : [],
    additionalInfo: Array.isArray(e && e.additional_info) ? e.additional_info.slice(0, 5).map((x) => sanitizeMessage(x)) : [],
  })) : [];
  return { canSend: h.can_send_message ? String(h.can_send_message) : null, entities };
}

function normaliseWaba(raw, fieldsDegraded) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return Object.assign({}, r, {
    id: r.id === undefined || r.id === null ? null : String(r.id),
    name: r.name || null,
    currency: r.currency || null,
    businessVerificationStatus: r.business_verification_status || null,
    healthStatus: normaliseHealth(r.health_status),
    messagingLimit: r.whatsapp_business_manager_messaging_limit !== undefined ? r.whatsapp_business_manager_messaging_limit : (r.messaging_limit_tier !== undefined ? r.messaging_limit_tier : null),
    ownershipType: r.ownership_type || null,
    country: r.country || null,
    status: r.status || null,
    primaryFundingId: r.primary_funding_id !== undefined && r.primary_funding_id !== null ? String(r.primary_funding_id) : null,
    fieldsDegraded: !!fieldsDegraded,
  });
}

function normaliseTemplate(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return Object.assign({}, r, {
    id: r.id === undefined || r.id === null ? null : String(r.id),
    name: r.name || null,
    language: r.language || null,
    status: r.status || null,
    category: r.category || null,
    qualityScore: r.quality_score && r.quality_score.score ? String(r.quality_score.score) : null,
    rejectedReason: r.rejected_reason || null,
  });
}

function normaliseDebug(d) {
  const r = d && typeof d === 'object' ? d : {};
  const expiresSec = typeof r.expires_at === 'number' ? r.expires_at : null;
  const dataSec = typeof r.data_access_expires_at === 'number' ? r.data_access_expires_at : null;
  const granular = Array.isArray(r.granular_scopes) ? r.granular_scopes.map((g) => ({
    scope: g && g.scope ? String(g.scope) : '',
    targetIds: Array.isArray(g && g.target_ids) ? g.target_ids.map((x) => String(x)) : [],
  })) : [];
  const wabaTargets = [];
  for (const g of granular) {
    if (g.scope !== 'whatsapp_business_management') continue;
    for (const id of g.targetIds) if (!wabaTargets.includes(id)) wabaTargets.push(id);
  }
  const err = r.error && typeof r.error === 'object' ? { code: toInt(r.error.code), subcode: toInt(r.error.subcode !== undefined ? r.error.subcode : r.error.error_subcode), message: sanitizeMessage(r.error.message) } : null;
  return {
    appId: r.app_id === undefined ? null : String(r.app_id),
    type: r.type || null,
    isValid: r.is_valid === true,
    // expires_at 0 means "never expires" (AU4 1.3): expiresAt null + neverExpires true
    expiresAt: expiresSec && expiresSec > 0 ? new Date(expiresSec * 1000) : null,
    neverExpires: expiresSec === 0,
    dataAccessExpiresAt: dataSec && dataSec > 0 ? new Date(dataSec * 1000) : null,
    issuedAt: typeof r.issued_at === 'number' && r.issued_at > 0 ? new Date(r.issued_at * 1000) : null,
    scopes: Array.isArray(r.scopes) ? r.scopes.map((s) => String(s)) : [],
    granularScopes: granular,
    wabaTargetIds: wabaTargets,
    userId: r.user_id === undefined || r.user_id === null ? null : String(r.user_id),
    error: err,
    // raw aliases (snake_case) for consumers that follow the Graph names
    is_valid: r.is_valid === true,
    expires_at: expiresSec,
    data_access_expires_at: dataSec,
    granular_scopes: Array.isArray(r.granular_scopes) ? r.granular_scopes : [],
    user_id: r.user_id === undefined || r.user_id === null ? null : String(r.user_id),
    app_id: r.app_id === undefined ? null : String(r.app_id),
  };
}

// ---- the client ----------------------------------------------------------------------------------------------------

/**
 * @param {{ http?: {request:Function}, appId?: string, appSecret?: string, baseUrl?: string, timeoutMs?: number, appSecretProof?: boolean }} [opts]
 * @returns {object} the Graph client (methods of DB 6.2)
 */
function createMetaGraphClient(opts = {}) {
  const o = opts || {};
  let httpPort = o.http || null;
  const getHttp = () => { if (!httpPort) httpPort = metaConfig.defaultHttp(); return httpPort; };
  const base = () => String(o.baseUrl || metaConfig.GRAPH_BASE()).replace(/\/+$/, '');
  const timeout = () => (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : metaConfig.REQUEST_TIMEOUT_MS);
  const proofOn = () => (o.appSecretProof === undefined ? metaConfig.APPSECRET_PROOF_ON() : !!o.appSecretProof);
  const appId = o.appId ? String(o.appId) : null;
  const appSecret = o.appSecret ? String(o.appSecret) : null;

  function needApp() {
    if (!appId || !appSecret) throw invalid('The Meta app credentials are not configured', 'not_configured');
  }

  async function dispatch(cfg, secrets) {
    let res;
    try {
      res = await getHttp().request({ ...cfg, timeout: timeout(), validateStatus: () => true });
    } catch (e) {
      throw networkError(e, secrets);
    }
    if (!res || typeof res.status !== 'number') throw new MetaGraphError('Unexpected response from Graph', { kind: 'unknown', appCode: 'META_ERROR', retryable: true });
    const failed = res.status < 200 || res.status >= 300
      || (res.data && typeof res.data === 'object' && !Array.isArray(res.data) && res.data.error && typeof res.data.error === 'object');
    if (failed) throw errorFromResponse(res, secrets);
    return res;
  }

  /** A merchant-token call: Authorization header, optional appsecret_proof, path under the Graph base. */
  async function call(method, path, { token, params, data, secrets = [] } = {}) {
    needToken(token);
    const p = Object.assign({}, params || {});
    if (proofOn() && appSecret) p.appsecret_proof = crypto.createHmac('sha256', appSecret).update(token).digest('hex');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const cfg = { method, url: `${base()}/${path}`, headers };
    if (Object.keys(p).length) cfg.params = p;
    if (data !== undefined) { cfg.data = data; headers['Content-Type'] = 'application/json'; }
    const res = await dispatch(cfg, [token, appSecret, ...secrets]);
    return res.data;
  }

  /** GET a node with a field list; a 400 code 100 naming a requested field retries ONCE with the core list. */
  async function getNode(token, id, fields, coreFields, normalise) {
    const first = fieldList(fields, coreFields);
    try {
      const data = await call('GET', encodeURIComponent(pathId(id)), { token, params: { fields: first } });
      return normalise(data, false);
    } catch (err) {
      if (first === coreFields || !fieldWasRejected(err, first)) throw err;
      const data = await call('GET', encodeURIComponent(pathId(id)), { token, params: { fields: coreFields } });
      return normalise(data, true);
    }
  }

  function successOf(data, what) {
    if (data && data.success === true) return { success: true };
    if (data && data.success === false) throw new MetaGraphError(`${what} was not confirmed by Meta`, { kind: 'unknown', appCode: 'META_ERROR', retryable: false });
    return { success: true };
  }

  const client = {
    appId,

    /** GET /oauth/access_token. Accepts a JSON body, a JSON-looking string and a bare token string. */
    async exchangeCode(code) {
      needApp();
      if (typeof code !== 'string' || !code.trim()) throw invalid('An authorization code is required');
      const params = { client_id: appId, client_secret: appSecret, code: code.trim() };
      const redirect = metaConfig.EXCHANGE_REDIRECT_URI();
      if (redirect) params.redirect_uri = redirect;
      const res = await dispatch({ method: 'GET', url: `${base()}/oauth/access_token`, params, headers: { Accept: 'application/json' } }, [code.trim(), appSecret]);
      let body = res.data;
      if (typeof body === 'string') {
        const t = body.trim();
        if (t.startsWith('{')) { try { body = JSON.parse(t); } catch (_) { body = t; } } else body = t;
      }
      let token = null;
      let expiresIn = null;
      let tokenType = null;
      if (typeof body === 'string') token = body;
      else if (body && typeof body === 'object') {
        token = typeof body.access_token === 'string' ? body.access_token : null;
        tokenType = typeof body.token_type === 'string' ? body.token_type : null;
        const ex = Number(body.expires_in);
        expiresIn = Number.isFinite(ex) && ex > 0 ? ex : null;
      }
      if (!token || token.length < 10) throw new MetaGraphError('The code exchange returned no access token', { httpStatus: res.status, kind: 'unknown', appCode: 'META_ERROR', retryable: false });
      return { accessToken: token, tokenType, expiresIn };
    },

    /** GET /debug_token (auth per metaConfig.DEBUG_TOKEN_AUTH). Normalised; an invalid token is data (isValid:false), not an error. */
    async debugToken(token) {
      needApp();
      needToken(token);
      const appToken = `${appId}|${appSecret}`;
      const headers = { Accept: 'application/json' };
      const params = { input_token: token };
      if (metaConfig.DEBUG_TOKEN_AUTH === 'header') headers.Authorization = `Bearer ${appToken}`;
      else params.access_token = appToken;
      const res = await dispatch({ method: 'GET', url: `${base()}/debug_token`, params, headers }, [token, appSecret, appToken]);
      return normaliseDebug(res.data && res.data.data);
    },

    /** GET /{phone-number-id}?fields= (full list, negotiated down to the core list). */
    getPhone(token, id, fields) {
      return getNode(token, id, fields || metaConfig.PHONE_FIELDS_FULL, metaConfig.PHONE_FIELDS_CORE, normalisePhone);
    },

    /** GET /{waba-id}/phone_numbers?fields= -> array of phones (Graph order: newest onboarded first). */
    async listPhones(token, wabaId, fields) {
      const csv = fieldList(fields, metaConfig.PHONE_FIELDS_CORE);
      const run = (f) => call('GET', `${encodeURIComponent(pathId(wabaId))}/phone_numbers`, { token, params: { fields: f } });
      let degraded = false;
      let data;
      try { data = await run(csv); } catch (err) {
        if (csv === metaConfig.PHONE_FIELDS_CORE || !fieldWasRejected(err, csv)) throw err;
        degraded = true;
        data = await run(metaConfig.PHONE_FIELDS_CORE);
      }
      const rows = (data && Array.isArray(data.data) ? data.data : []).map((p) => normalisePhone(p, degraded));
      return withHidden(rows, { rows, fieldsDegraded: degraded });
    },

    /** POST /{phone-number-id}/register { messaging_product, pin } (the PIN is never put in an error). */
    async registerPhone(token, id, pin) {
      const p = typeof pin === 'number' ? String(pin) : pin;
      if (typeof p !== 'string' || !new RegExp(`^\\d{${metaConfig.REGISTER_PIN_LENGTH}}$`).test(p)) throw invalid('A 6-digit PIN is required');
      const data = await call('POST', `${encodeURIComponent(pathId(id))}/register`, { token, data: { messaging_product: 'whatsapp', pin: p }, secrets: [p] });
      return successOf(data, 'Registration');
    },

    /** POST /{waba-id}/subscribed_apps (no body, no override). */
    async subscribeApp(token, wabaId) {
      const data = await call('POST', `${encodeURIComponent(pathId(wabaId))}/subscribed_apps`, { token });
      return successOf(data, 'Subscription');
    },

    /** GET /{waba-id}/subscribed_apps -> { apps:[{id,name,link,overrideCallbackUri}], appIds, data } */
    async listSubscribedApps(token, wabaId) {
      const data = await call('GET', `${encodeURIComponent(pathId(wabaId))}/subscribed_apps`, { token });
      const rows = data && Array.isArray(data.data) ? data.data : [];
      const apps = rows.map((r) => {
        const a = (r && r.whatsapp_business_api_data) || {};
        return { id: a.id === undefined ? null : String(a.id), name: a.name ? sanitizeMessage(a.name) : null, link: a.link || null, overrideCallbackUri: r && r.override_callback_uri ? String(r.override_callback_uri).slice(0, 200) : null };
      });
      return { apps, appIds: apps.map((a) => a.id).filter(Boolean), data: rows };
    },

    /** DELETE /{waba-id}/subscribed_apps */
    async unsubscribeApp(token, wabaId) {
      const data = await call('DELETE', `${encodeURIComponent(pathId(wabaId))}/subscribed_apps`, { token });
      return successOf(data, 'Unsubscription');
    },

    /** GET /{waba-id}?fields=WABA_FIELDS (negotiated). */
    getWaba(token, id, fields) {
      return getNode(token, id, fields || metaConfig.WABA_FIELDS(), WABA_FIELDS_CORE, normaliseWaba);
    },

    /** GET /{business-id}?fields=verification_status */
    async getBusiness(token, id) {
      const data = await call('GET', encodeURIComponent(pathId(id)), { token, params: { fields: 'id,verification_status' } });
      const r = data && typeof data === 'object' ? data : {};
      return Object.assign({}, r, { id: r.id === undefined ? null : String(r.id), verificationStatus: r.verification_status || null });
    },

    /** POST /{phone-number-id} { new_display_name } */
    async setDisplayName(token, phoneId, name) {
      const n = typeof name === 'string' ? name.trim() : '';
      if (!n || n.length > metaConfig.DISPLAY_NAME_MAX) throw invalid('Invalid display name');
      const data = await call('POST', encodeURIComponent(pathId(phoneId)), { token, data: { new_display_name: n } });
      return successOf(data, 'The display name change');
    },

    /** POST /{waba-id}/message_templates -> { id, status, category } */
    async submitTemplate(token, wabaId, payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('A template payload is required');
      const data = await call('POST', `${encodeURIComponent(pathId(wabaId))}/message_templates`, { token, data: payload });
      const r = data && typeof data === 'object' ? data : {};
      return { id: r.id === undefined ? null : String(r.id), status: r.status || null, category: r.category || null };
    },

    /**
     * GET /{waba-id}/message_templates -> array of templates (non-enumerable `rows`, `summary`, `truncated`).
     * paging.next is followed only when it points back to the Graph origin (the link may carry credentials).
     * @param {{name?:string, status?:string, language?:string, fields?:string|string[], limit?:number, maxPages?:number}} [q]
     */
    async listTemplates(token, wabaId, q = {}) {
      const params = { fields: fieldList(q.fields, TEMPLATE_FIELDS), limit: Math.max(1, Math.min(100, parseInt(q.limit, 10) || 100)) };
      if (q.name) params.name = String(q.name);
      if (q.status) params.status = String(q.status);
      if (q.language) params.language = String(q.language);
      const maxPages = Math.max(1, Math.min(MAX_PAGES, parseInt(q.maxPages, 10) || MAX_PAGES));
      const origin = new URL(`${base()}/`).origin;
      const rows = [];
      let summary = null;
      let truncated = false;
      let data = await call('GET', `${encodeURIComponent(pathId(wabaId))}/message_templates`, { token, params });
      for (let page = 1; ; page += 1) {
        if (data && Array.isArray(data.data)) data.data.forEach((t) => rows.push(normaliseTemplate(t)));
        if (data && data.summary && !summary) summary = data.summary;
        const next = data && data.paging && typeof data.paging.next === 'string' ? data.paging.next : null;
        if (!next) break;
        if (!sameOrigin(next, origin)) { truncated = true; break; }
        if (page >= maxPages) { truncated = true; break; }
        const u = new URL(next);
        u.searchParams.delete('access_token'); // never send a token in a URL
        const headers = { Authorization: `Bearer ${needToken(token)}`, Accept: 'application/json' };
        const res = await dispatch({ method: 'GET', url: u.toString(), headers }, [token, appSecret]);
        data = res.data;
      }
      return withHidden(rows, { rows, summary: summary || null, truncated });
    },

    /** One template by { id } or { name, language }; null when none matches. */
    async getTemplate(token, wabaId, sel = {}) {
      if (sel.id) {
        const data = await call('GET', encodeURIComponent(pathId(sel.id)), { token, params: { fields: TEMPLATE_FIELDS } });
        return normaliseTemplate(data);
      }
      if (!sel.name) throw invalid('A template id or name is required');
      const rows = await client.listTemplates(token, wabaId, { name: sel.name, language: sel.language, maxPages: 5 });
      const exact = rows.filter((t) => t.name === sel.name && (!sel.language || t.language === sel.language));
      return exact.length ? exact[0] : null;
    },

    /** POST /{phone-number-id}/messages (template). Resolves { messageId, waId }. */
    async sendTemplateMessage(token, phoneId, msg = {}) {
      const to = typeof msg.to === 'string' || typeof msg.to === 'number' ? String(msg.to).replace(/^\+/, '') : '';
      if (!/^\d{6,20}$/.test(to)) throw invalid('Invalid recipient');
      if (!msg.name || !msg.languageCode) throw invalid('A template name and language are required');
      const template = { name: String(msg.name), language: { code: String(msg.languageCode) } };
      if (Array.isArray(msg.components) && msg.components.length) template.components = msg.components;
      const data = await call('POST', `${encodeURIComponent(pathId(phoneId))}/messages`, { token, data: { messaging_product: 'whatsapp', to, type: 'template', template }, secrets: [to] });
      const r = data && typeof data === 'object' ? data : {};
      const messageId = Array.isArray(r.messages) && r.messages[0] && r.messages[0].id ? String(r.messages[0].id) : null;
      const waId = Array.isArray(r.contacts) && r.contacts[0] && r.contacts[0].wa_id ? String(r.contacts[0].wa_id) : null;
      return { messageId, waId };
    },
  };

  return client;
}

// ---- default client (lazy, credentials from the environment) -------------------------------------------------------

let defaultClient = null;
let defaultSignature = null;

/** The shared client built from env (META_ES_APP_ID|WA_APP_ID, META_ES_APP_SECRET|WA_APP_SECRET). Rebuilt when those change. */
function getDefaultClient() {
  const appId = metaConfig.metaEsAppId();
  const secret = (process.env.META_ES_APP_SECRET && String(process.env.META_ES_APP_SECRET).trim()) || (process.env.WA_APP_SECRET && String(process.env.WA_APP_SECRET).trim()) || null;
  const signature = `${appId || ''}|${secret ? crypto.createHash('sha256').update(secret).digest('hex') : ''}|${metaConfig.GRAPH_BASE()}`;
  if (!defaultClient || defaultSignature !== signature) {
    defaultClient = createMetaGraphClient({ appId, appSecret: secret });
    defaultSignature = signature;
  }
  return defaultClient;
}

/** HMAC-SHA256(token, appSecret) hex: the appsecret_proof Graph parameter. */
function appSecretProof(token, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(token)).digest('hex');
}

module.exports = {
  createMetaGraphClient,
  getDefaultClient,
  MetaGraphError,
  // additions (documented in B1-c.md)
  sanitizeMessage,
  appSecretProof,
  WABA_FIELDS_CORE,
};
