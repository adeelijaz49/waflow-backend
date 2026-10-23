'use strict';
// Fake Meta Graph API for the onboarding tests. Implements the HTTP port of BRIEF-BUILD section 5:
//   http.request({ method, url, params, data, headers, timeout, validateStatus })
//     -> resolves { status, data, headers } for EVERY HTTP status (validateStatus is ignored),
//     -> rejects { code: 'ECONNRESET'|'ECONNABORTED'|'ETIMEDOUT'|..., message } for network failures.
// Wire shapes: AU4 MOCK CONTRACT (wins) + DB-backend.md 6.2. Nothing here opens a socket.
//
// Facts that are UNVERIFIED in AU4 stay configurable here (never silently "right"):
// exchange response encoding, redirect_uri, name_status availability, 133010/131042 meanings,
// the display-name edit limit error, template-limit behaviour.

const crypto = require('crypto');
const { fixedClock } = require('./helpers');

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v25.0';

const TEMPLATE_STATUSES = ['APPROVED', 'IN_APPEAL', 'PENDING', 'REJECTED', 'PENDING_DELETION', 'DELETED', 'DISABLED', 'PAUSED', 'LIMIT_EXCEEDED', 'ARCHIVED'];
const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
const DEFAULT_LANGUAGES = ['en', 'en_US', 'en_GB', 'ar', 'ar_EG', 'ar_AE', 'ar_LB', 'ar_MA', 'ar_QA', 'fr', 'es', 'de', 'tr', 'ur', 'hi', 'id', 'pt_BR', 'it', 'ru', 'ms'];

const PHONE_KNOWN = ['id', 'display_phone_number', 'verified_name', 'name_status', 'new_display_name', 'new_name_status', 'quality_rating', 'code_verification_status', 'status', 'platform_type', 'is_on_biz_app', 'whatsapp_business_manager_messaging_limit', 'messaging_limit_tier', 'throughput', 'webhook_configuration', 'last_onboarded_time', 'account_mode', 'quality_score'];
const WABA_KNOWN = ['id', 'name', 'currency', 'timezone_id', 'message_template_namespace', 'business_verification_status', 'health_status', 'primary_funding_id', 'whatsapp_business_manager_messaging_limit', 'messaging_limit_tier', 'ownership_type', 'country', 'status', 'on_behalf_of_business_info', 'purchase_order_number', 'analytics'];
const BUSINESS_KNOWN = ['id', 'name', 'verification_status', 'whatsapp_business_manager_messaging_limit', 'created_time'];

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, ''); }
function unb64(s) { return Buffer.from(String(s), 'base64').toString('utf8'); }

/**
 * Graph error response (status 400 by default), the AU4 body shape.
 * @param {{code: number, subcode?: number, message?: string, type?: string, status?: number, title?: string, userMsg?: string}} o
 */
function graphError(o = {}) {
  return {
    status: o.status || 400,
    data: {
      error: {
        message: o.message || ('(#' + (o.code || 1) + ') Fake Graph error'),
        type: o.type || 'OAuthException',
        code: o.code === undefined ? 1 : o.code,
        error_subcode: o.subcode,
        error_user_title: o.title,
        error_user_msg: o.userMsg,
        fbtrace_id: 'FakeTrace' + (o.code === undefined ? 1 : o.code),
      },
    },
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-fb-trace-id': 'FakeTrace' },
  };
}

function buildDefaults() {
  return {
    appId: 'APP_ID_FIXTURE',
    appSecret: 'APP_SECRET_FIXTURE_0123456789abcdef',
    businessId: '1098765432100003',
    wabaId: '1098765432100001',
    phoneId: '1098765432100002',
    displayNumber: '+966 55 123 4567',
    verifiedName: 'Acme Coffee',
    wabaName: 'Acme Coffee',
    nameStatus: 'APPROVED',
    qualityRating: 'GREEN',
    codeVerificationStatus: 'VERIFIED',
    phoneStatus: 'CONNECTED',
    platformType: 'CLOUD_API',
    isOnBizApp: false,
    tier: 'TIER_250',
    verificationStatus: 'verified', // WABA business_verification_status
    portfolioVerification: undefined, // Business node verification_status (defaults to the line above)
    health: 'AVAILABLE',
    primaryFundingId: undefined, // set a string to make primary_funding_id appear on the WABA node
    subscribed: true,
    phones: undefined, // array of per-phone overrides; [] = a WABA with no phone number
    merchantToken: 'EAAFXTmerchantTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz',
    platformToken: 'EAAFXTplatformTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz',
    extraValidTokens: [],
    code: undefined, // undefined = any fresh non-empty code is accepted (single-use)
    exchangeStyle: 'json', // 'json' | 'text' (bare string body) | 'noExpiry'
    expiresIn: 5183999,
    expectRedirectUri: undefined, // string -> exchange demands it (400 100/36008 otherwise)
    tokenExpiresAtSec: 0, // debug_token.expires_at (0 = never)
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    extraWabaIds: [],
    rejectFields: [], // field names that make a node GET answer 400 code 100 naming them
    omitNameStatus: false, // name_status silently absent (AU4: "field not available")
    strictFields: true, // unknown field on a node -> 400 code 100 (faithful to Graph)
    languages: DEFAULT_LANGUAGES,
    enforceApproved: false, // sendMessage: unknown / unapproved template -> 400 132001
    maxNameEdits: 10,
    pagingOrigin: GRAPH_ORIGIN,
    pagingNextIncludesToken: false,
    templateLimit: 250,
    delayMs: 0,
    clock: undefined,
  };
}

/**
 * @param {object} [options] see buildDefaults() above; every key is optional.
 */
function createFakeGraph(options = {}) {
  const o = Object.assign(buildDefaults(), options);
  const clock = o.clock || fixedClock();

  // ------------------------------------------------------------------ state
  let state;
  function buildState() {
    const phoneDefs = Array.isArray(o.phones) ? o.phones : [{}];
    const base = clock.sec();
    const phones = phoneDefs.map((p, i) => Object.assign({
      id: i === 0 ? o.phoneId : o.phoneId + '_' + i,
      display_phone_number: i === 0 ? o.displayNumber : '+966 55 000 000' + i,
      verified_name: o.verifiedName,
      name_status: o.nameStatus,
      new_display_name: undefined,
      new_name_status: undefined,
      quality_rating: o.qualityRating,
      code_verification_status: o.codeVerificationStatus,
      status: o.phoneStatus,
      platform_type: o.platformType,
      is_on_biz_app: o.isOnBizApp,
      throughput: { level: 'STANDARD' },
      last_onboarded_time: new Date((base - 86400 + i * 60) * 1000).toISOString(),
      pin: undefined,
      nameEdits: 0,
    }, p));
    return {
      wabaIds: [o.wabaId].concat(o.extraWabaIds || []),
      phones,
      tier: o.tier,
      verificationStatus: o.verificationStatus,
      portfolioVerification: o.portfolioVerification === undefined ? o.verificationStatus : o.portfolioVerification,
      health: o.health,
      healthEntities: undefined,
      primaryFundingId: o.primaryFundingId,
      subscribed: new Set(o.subscribed ? [o.wabaId] : []),
      override: null,
      validTokens: new Set([o.merchantToken].concat(o.extraValidTokens || [])),
      usedCodes: new Set(),
      exchanges: 0,
      tokenExpiresAtSec: o.tokenExpiresAtSec,
      scopes: o.scopes.slice(),
      rejectFields: new Set(o.rejectFields || []),
      omitNameStatus: !!o.omitNameStatus,
      templates: [],
      nextTemplateId: 1689556908129832,
      sentMessages: [],
      registerCount: 0,
      nextMessageId: 1,
    };
  }
  state = buildState();

  const calls = [];
  const interceptors = []; // { test, respond, times, label }
  const pagingIssued = new Set();

  // ------------------------------------------------------------------ helpers
  const appToken = () => o.appId + '|' + o.appSecret;
  function kindOfToken(tok) {
    if (!tok) return null;
    if (tok === appToken()) return 'app';
    if (state.validTokens.has(tok)) return 'merchant';
    if (tok === o.platformToken) return 'platform';
    return 'unknown';
  }
  const phoneById = (id) => state.phones.find((p) => p.id === id);
  const isWaba = (id) => state.wabaIds.includes(id);
  const nodeError = (verb, id) => graphError({
    code: 100, subcode: 33, status: 400,
    message: 'Unsupported ' + verb + ' request. Object with ID \'' + id + '\' does not exist, cannot be loaded due to missing permissions, or does not support this operation',
    type: 'GraphMethodException',
  });
  const oauthExpired = () => graphError({ code: 190, subcode: 463, message: 'Error validating access token: Session has expired', type: 'OAuthException' });

  function parseUrl(raw, baseURL) {
    let u = String(raw || '');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      const base = baseURL ? String(baseURL).replace(/\/+$/, '') : GRAPH_ORIGIN + '/' + GRAPH_VERSION;
      u = base + '/' + u.replace(/^\/+/, '');
    }
    const parsed = new URL(u);
    let pathname = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    let version = null;
    const m = /^(v\d+\.\d+)\/(.*)$/.exec(pathname);
    if (m) { version = m[1]; pathname = m[2]; }
    const query = {};
    parsed.searchParams.forEach((v, k) => { query[k] = v; });
    return { origin: parsed.origin, path: pathname, version, query, href: u };
  }

  function bodyOf(data) {
    if (data === undefined || data === null) return undefined;
    if (Buffer.isBuffer(data)) data = data.toString('utf8');
    if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
      const out = {};
      data.forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (typeof data === 'string') {
      const t = data.trim();
      if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch (e) { /* fall through */ } }
      const out = {};
      new URLSearchParams(data).forEach((v, k) => { out[k] = v; });
      return out;
    }
    return clone(data);
  }

  function headerGet(headers, name) {
    if (!headers) return null;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : headers[key];
  }

  function route(method, path) {
    const seg = path.split('/').filter(Boolean);
    const M = method;
    if (seg.length === 2 && seg[0] === 'oauth' && seg[1] === 'access_token' && M === 'GET') return { name: 'exchange' };
    if (seg.length === 1 && seg[0] === 'debug_token' && M === 'GET') return { name: 'debugToken' };
    if (seg.length === 1) {
      const id = seg[0];
      if (M === 'GET') {
        if (phoneById(id)) return { name: 'getPhone', id };
        if (isWaba(id)) return { name: 'getWaba', id };
        if (id === o.businessId) return { name: 'getBusiness', id };
        return { name: 'getNode', id };
      }
      if (M === 'POST') return { name: phoneById(id) ? 'setDisplayName' : 'postNode', id };
    }
    if (seg.length === 2) {
      const id = seg[0];
      const edge = seg[1];
      const table = {
        'phone_numbers:GET': 'listPhones', 'register:POST': 'register', 'subscribed_apps:POST': 'subscribe',
        'subscribed_apps:GET': 'listSubscribed', 'subscribed_apps:DELETE': 'unsubscribe',
        'message_templates:POST': 'createTemplate', 'message_templates:GET': 'listTemplates',
        'message_templates:DELETE': 'deleteTemplate', 'messages:POST': 'sendMessage',
        'request_code:POST': 'requestCode', 'verify_code:POST': 'verifyCode',
        'client_whatsapp_business_accounts:GET': 'listClientWabas',
      };
      const name = table[edge + ':' + M];
      if (name) return { name, id };
      if (table[edge + ':GET'] || table[edge + ':POST'] || table[edge + ':DELETE']) return { name: 'badMethod', id };
    }
    return { name: 'unknownPath' };
  }

  function compileMatcher(m) {
    if (typeof m === 'function') return m;
    if (m instanceof RegExp) return (c) => m.test(c.method + ' ' + c.path);
    if (typeof m === 'string') return (c) => c.name === m || c.path.includes(m);
    if (m && typeof m === 'object') {
      return (c) => (m.name === undefined || c.name === m.name)
        && (m.method === undefined || c.method === String(m.method).toUpperCase())
        && (m.path === undefined || (m.path instanceof RegExp ? m.path.test(c.path) : c.path.includes(m.path)))
        && (m.token === undefined || c.token === m.token)
        && (m.where === undefined || m.where(c));
    }
    return () => true;
  }

  /** Normalise a user/responder spec into { status, data, headers } | { reject }. */
  function normalise(spec, call) {
    let r = typeof spec === 'function' ? spec(call, api) : spec;
    if (r === undefined) return undefined;
    if (r && r.then) throw new Error('fakeGraph: responders must be synchronous');
    if (r && (r.networkError !== undefined || r.reject !== undefined)) {
      const n = r.networkError !== undefined ? r.networkError : r.reject;
      const code = typeof n === 'string' ? n : (n && n.code) || 'ECONNRESET';
      return { reject: { code, message: (n && n.message) || ('fake network failure: ' + code) } };
    }
    if (r && r.status !== undefined) return { status: r.status, data: clone(r.data), headers: Object.assign({ 'content-type': 'application/json; charset=UTF-8' }, r.headers || {}) };
    if (r && (r.code !== undefined || r.message !== undefined) && r.error === undefined) return graphError(r);
    if (r && r.error) return { status: 400, data: clone(r), headers: { 'content-type': 'application/json; charset=UTF-8' } };
    return { status: 200, data: clone(r), headers: { 'content-type': 'application/json; charset=UTF-8' } };
  }

  const ok = (data) => ({ status: 200, data, headers: { 'content-type': 'application/json; charset=UTF-8', 'x-fb-trace-id': 'FakeTrace' } });

  // ------------------------------------------------------------------ node views
  function requestedFields(call, fallback) {
    const f = call.params && call.params.fields;
    if (typeof f !== 'string' || !f.trim()) return fallback;
    return f.split(',').map((s) => s.trim()).filter(Boolean);
  }

  function fieldCheck(fields, known, nodeType, extraKnown) {
    for (const f of fields) {
      if (state.rejectFields.has(f)) {
        return graphError({ code: 100, message: '(#100) Tried accessing nonexisting field (' + f + ') on node type (' + nodeType + ')', type: 'GraphMethodException' });
      }
    }
    if (o.strictFields) {
      for (const f of fields) {
        if (!known.includes(f) && !(extraKnown || []).includes(f)) {
          return graphError({ code: 100, message: '(#100) Tried accessing nonexisting field (' + f + ') on node type (' + nodeType + ')', type: 'GraphMethodException' });
        }
      }
    }
    return null;
  }

  function phoneView(p, fields) {
    const avail = {
      id: p.id,
      display_phone_number: p.display_phone_number,
      verified_name: p.verified_name,
      name_status: state.omitNameStatus ? undefined : p.name_status,
      new_display_name: p.new_display_name,
      new_name_status: state.omitNameStatus ? undefined : p.new_name_status,
      quality_rating: p.quality_rating,
      code_verification_status: p.code_verification_status,
      status: p.status,
      platform_type: p.platform_type,
      is_on_biz_app: p.is_on_biz_app,
      whatsapp_business_manager_messaging_limit: state.tier,
      messaging_limit_tier: state.tier,
      throughput: p.throughput,
      webhook_configuration: { application: 'https://callback.example.test/webhook' },
      last_onboarded_time: p.last_onboarded_time,
      account_mode: 'LIVE',
      quality_score: { score: p.quality_rating },
    };
    const out = { id: p.id };
    fields.forEach((f) => { if (avail[f] !== undefined) out[f] = clone(avail[f]); });
    return out;
  }

  function healthView() {
    const lvl = state.health;
    if (state.healthEntities) return { can_send_message: lvl, entities: clone(state.healthEntities) };
    const entities = [{ entity_type: 'WABA', id: state.wabaIds[0], can_send_message: 'AVAILABLE' }];
    state.phones.forEach((p) => entities.push({ entity_type: 'PHONE_NUMBER', id: p.id, can_send_message: 'AVAILABLE' }));
    if (lvl === 'BLOCKED') {
      entities[0] = { entity_type: 'WABA', id: state.wabaIds[0], can_send_message: 'BLOCKED', errors: [{ error_code: 141002, error_description: 'Your WhatsApp Business Account is blocked from sending messages.', possible_solution: 'Check the account status in WhatsApp Manager.' }] };
    } else if (lvl === 'LIMITED' && entities[1]) {
      entities[1] = { entity_type: 'PHONE_NUMBER', id: entities[1].id, can_send_message: 'LIMITED', additional_info: ['Your display name has not been approved yet.'] };
    } else if (lvl === 'LIMITED') {
      entities[0] = { entity_type: 'WABA', id: state.wabaIds[0], can_send_message: 'LIMITED', additional_info: ['Your account has limited sending capability.'] };
    }
    return { can_send_message: lvl, entities };
  }

  function wabaView(fields) {
    const avail = {
      id: state.wabaIds[0],
      name: o.wabaName,
      currency: 'SAR',
      timezone_id: '3',
      message_template_namespace: 'abc_12',
      business_verification_status: state.verificationStatus,
      health_status: healthView(),
      primary_funding_id: state.primaryFundingId,
      whatsapp_business_manager_messaging_limit: state.tier,
      messaging_limit_tier: state.tier,
      ownership_type: 'CLIENT_OWNED',
      country: 'SA',
      status: 'APPROVED',
    };
    const out = { id: avail.id };
    fields.forEach((f) => { if (avail[f] !== undefined) out[f] = clone(avail[f]); });
    return out;
  }

  const TEMPLATE_DEFAULT_FIELDS = ['name', 'language', 'status', 'category', 'id'];
  function templateView(t, fields) {
    const avail = {
      id: t.id, name: t.name, language: t.language, status: t.status, category: t.category,
      sub_category: t.sub_category, quality_score: t.quality_score, components: t.components,
      rejected_reason: t.rejected_reason, parameter_format: t.parameter_format,
      correct_category: t.correct_category, previous_category: t.previous_category,
    };
    const out = { id: t.id };
    fields.forEach((f) => { if (avail[f] !== undefined) out[f] = clone(avail[f]); });
    return out;
  }

  // ------------------------------------------------------------------ handlers
  const handlers = {
    exchange(call) {
      const p = call.params || {};
      if (p.client_id !== o.appId || p.client_secret !== o.appSecret) {
        return graphError({ code: 1, message: 'Error validating client secret.', type: 'OAuthException' });
      }
      const invalidCode = () => graphError({ code: 100, message: 'Invalid verification code format.', type: 'OAuthException' });
      if (typeof p.code !== 'string' || !p.code) return invalidCode();
      if (o.code !== undefined && p.code !== o.code) return invalidCode();
      if (state.usedCodes.has(p.code)) return invalidCode();
      if (o.expectRedirectUri !== undefined && p.redirect_uri !== o.expectRedirectUri) {
        return graphError({ code: 100, subcode: 36008, message: 'Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request', type: 'OAuthException' });
      }
      state.usedCodes.add(p.code);
      state.exchanges += 1;
      state.validTokens.add(o.merchantToken);
      if (o.exchangeStyle === 'text') {
        return { status: 200, data: o.merchantToken, headers: { 'content-type': 'text/plain; charset=UTF-8' } };
      }
      const body = { access_token: o.merchantToken, token_type: 'bearer' };
      if (o.exchangeStyle !== 'noExpiry') body.expires_in = o.expiresIn;
      return ok(body);
    },

    debugToken(call) {
      const p = call.params || {};
      const kind = call.tokenKind;
      if (kind !== 'app' && kind !== 'merchant') {
        return graphError({ code: 190, message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException' });
      }
      const input = p.input_token;
      if (!input || !state.validTokens.has(input)) {
        return ok({ data: { app_id: o.appId, type: 'UNKNOWN', application: 'WaFlow', is_valid: false, scopes: [], error: { code: 190, subcode: 467, message: 'Invalid OAuth access token - Cannot parse access token' } } });
      }
      const now = clock.sec();
      const data = {
        app_id: o.appId, type: 'SYSTEM_USER', application: 'WaFlow',
        expires_at: state.tokenExpiresAtSec,
        data_access_expires_at: now + 90 * 86400,
        is_valid: true,
        scopes: state.scopes.slice(),
        granular_scopes: state.scopes.map((s) => ({ scope: s, target_ids: state.wabaIds.slice() })),
        issued_at: now - 86400,
        user_id: 'SYSTEM_USER_FIXTURE_1',
      };
      return ok({ data });
    },

    getPhone(call) {
      const p = phoneById(call.id);
      const fields = requestedFields(call, ['id', 'display_phone_number', 'verified_name', 'quality_rating']);
      const bad = fieldCheck(fields, PHONE_KNOWN, 'WhatsAppBusinessPhoneNumber');
      if (bad) return bad;
      return ok(phoneView(p, fields));
    },

    getWaba(call) {
      const fields = requestedFields(call, ['id', 'name', 'currency', 'timezone_id', 'message_template_namespace']);
      const bad = fieldCheck(fields, WABA_KNOWN, 'WhatsAppBusinessAccount');
      if (bad) return bad;
      return ok(wabaView(fields));
    },

    getBusiness(call) {
      const fields = requestedFields(call, ['id', 'name']);
      const bad = fieldCheck(fields, BUSINESS_KNOWN, 'Business');
      if (bad) return bad;
      const avail = { id: o.businessId, name: o.wabaName, verification_status: state.portfolioVerification, whatsapp_business_manager_messaging_limit: state.tier, created_time: '2026-01-01T00:00:00+0000' };
      const out = { id: o.businessId };
      fields.forEach((f) => { if (avail[f] !== undefined) out[f] = avail[f]; });
      return ok(out);
    },

    getNode(call) { return nodeError('get', call.id); },
    postNode(call) { return nodeError('post', call.id); },
    badMethod(call) { return nodeError(call.method.toLowerCase(), call.id); },
    unknownPath() { return graphError({ code: 2500, message: 'Unknown path components', type: 'OAuthException' }); },

    listPhones(call) {
      if (!isWaba(call.id)) return nodeError('get', call.id);
      const fields = requestedFields(call, ['id', 'display_phone_number', 'verified_name', 'quality_rating']);
      const bad = fieldCheck(fields, PHONE_KNOWN, 'WhatsAppBusinessPhoneNumber');
      if (bad) return bad;
      const rows = state.phones.slice().sort((a, b) => String(b.last_onboarded_time).localeCompare(String(a.last_onboarded_time)));
      return ok({ data: rows.map((p) => phoneView(p, fields)), paging: { cursors: { before: 'QVFIfakeBefore', after: 'QVFIfakeAfter' } } });
    },

    register(call) {
      const p = phoneById(call.id);
      if (!p) return nodeError('post', call.id);
      const d = call.data || {};
      if (d.messaging_product !== 'whatsapp') return graphError({ code: 100, message: '(#100) The parameter messaging_product is required.', type: 'OAuthException' });
      if (!/^\d{6}$/.test(String(d.pin === undefined ? '' : d.pin))) return graphError({ code: 100, message: '(#100) Invalid parameter: pin must be a 6 digit number.', type: 'OAuthException' });
      state.registerCount += 1;
      if (p.name_status === 'NONE' || p.name_status === 'EXPIRED') {
        // AU4 2.1: numbers with display name status NONE / EXPIRED cannot be registered.
        return graphError({ code: 100, message: '(#100) Display name must be approved before registering.', type: 'OAuthException' });
      }
      p.pin = String(d.pin);
      p.status = 'CONNECTED';
      return ok({ success: true });
    },

    subscribe(call) {
      if (!isWaba(call.id)) return nodeError('post', call.id);
      const d = call.data || {};
      state.override = d.override_callback_uri ? { override_callback_uri: d.override_callback_uri, verify_token: d.verify_token } : null;
      state.subscribed.add(call.id);
      return ok({ success: true });
    },
    listSubscribed(call) {
      if (!isWaba(call.id)) return nodeError('get', call.id);
      if (!state.subscribed.has(call.id)) return ok({ data: [] });
      const row = { whatsapp_business_api_data: { id: o.appId, link: 'https://www.facebook.com/games/?app_id=' + o.appId, name: 'WaFlow' } };
      if (state.override) row.override_callback_uri = state.override.override_callback_uri;
      return ok({ data: [row] });
    },
    unsubscribe(call) {
      if (!isWaba(call.id)) return nodeError('delete', call.id);
      state.subscribed.delete(call.id);
      return ok({ success: true });
    },

    listClientWabas(call) {
      if (call.id !== o.businessId) return nodeError('get', call.id);
      return ok({ data: state.wabaIds.map((id) => ({ id, name: o.wabaName, currency: 'SAR', timezone_id: '3', message_template_namespace: 'abc_12' })) });
    },

    setDisplayName(call) {
      const p = phoneById(call.id);
      const d = Object.assign({}, call.params, call.data);
      if (d.new_display_name === undefined) return ok({ success: true });
      const name = String(d.new_display_name).trim();
      if (!name) return graphError({ code: 100, message: '(#100) new_display_name must be a non-empty string.', type: 'OAuthException' });
      if (p.nameEdits >= o.maxNameEdits) {
        // UNVERIFIED (AU4 section 5 item 7): the exact code is not documented; generic 100.
        return graphError({ code: 100, message: 'Too many display name changes in the last 30 days.', type: 'OAuthException' });
      }
      p.nameEdits += 1;
      p.new_display_name = name;
      p.new_name_status = 'PENDING_REVIEW';
      return ok({ success: true });
    },

    requestCode(call) {
      const p = phoneById(call.id);
      if (!p) return nodeError('post', call.id);
      const d = Object.assign({}, call.params, call.data);
      if (!['SMS', 'VOICE'].includes(d.code_method)) return graphError({ code: 100, message: '(#100) code_method must be SMS or VOICE.', type: 'OAuthException' });
      return ok({ success: true });
    },
    verifyCode(call) {
      const p = phoneById(call.id);
      if (!p) return nodeError('post', call.id);
      const d = Object.assign({}, call.params, call.data);
      if (!/^\d{6}$/.test(String(d.code === undefined ? '' : d.code))) return graphError({ code: 100, message: '(#100) Invalid verification code.', type: 'OAuthException' });
      p.code_verification_status = 'VERIFIED';
      return ok({ success: true });
    },

    createTemplate(call) {
      if (!isWaba(call.id)) return nodeError('post', call.id);
      if (!state.scopes.includes('whatsapp_business_management')) {
        return graphError({ code: 200, message: '(#200) Requires whatsapp_business_management permission to manage the object', type: 'OAuthException' });
      }
      const d = call.data || {};
      const bad = (message, subcode) => graphError({ code: 100, subcode, message: '(#100) ' + message, type: 'OAuthException' });
      if (typeof d.name !== 'string' || !/^[a-z0-9_]+$/.test(d.name) || d.name.length > 512) return bad('Invalid parameter: template name may only contain lowercase letters, numbers and underscores.');
      if (typeof d.language !== 'string' || !o.languages.includes(d.language)) return bad('Invalid parameter: unsupported template language.');
      if (!TEMPLATE_CATEGORIES.includes(d.category)) return bad('Invalid parameter: category must be one of ' + TEMPLATE_CATEGORIES.join(', ') + '.');
      if (!Array.isArray(d.components) || !d.components.length) return bad('Invalid parameter: components are required.');
      const body = d.components.find((c) => c && String(c.type).toUpperCase() === 'BODY');
      if (d.category !== 'AUTHENTICATION' && !(body && typeof body.text === 'string' && body.text)) return bad('Invalid parameter: a BODY component with text is required.');
      const dup = state.templates.find((t) => t.name === d.name && t.language === d.language && t.status !== 'DELETED');
      if (dup) {
        return graphError({ code: 100, subcode: 2388024, message: '(#100) Invalid parameter', type: 'OAuthException', title: 'Message template already exists', userMsg: 'Content in this language already exists for this template name.' });
      }
      const t = {
        id: String(state.nextTemplateId++), name: d.name, language: d.language, status: 'PENDING',
        category: d.category, components: clone(d.components), quality_score: { score: 'UNKNOWN' },
        parameter_format: d.parameter_format, allow_category_change: d.allow_category_change,
        createdSeq: state.templates.length + 1,
      };
      state.templates.push(t);
      return ok({ id: t.id, status: t.status, category: t.category });
    },

    listTemplates(call) {
      if (!isWaba(call.id)) return nodeError('get', call.id);
      const p = call.params || {};
      const fields = requestedFields(call, TEMPLATE_DEFAULT_FIELDS);
      for (const f of fields) {
        if (state.rejectFields.has(f)) return graphError({ code: 100, message: '(#100) Tried accessing nonexisting field (' + f + ') on node type (WhatsAppBusinessHSM)', type: 'GraphMethodException' });
      }
      let rows = state.templates.filter((t) => t.status !== 'DELETED');
      if (p.status) rows = rows.filter((t) => t.status === p.status);
      if (p.language) rows = rows.filter((t) => t.language === p.language);
      if (p.name) rows = rows.filter((t) => t.name.includes(String(p.name)));
      const limit = Math.max(1, parseInt(p.limit, 10) || 25);
      let offset = 0;
      if (p.after) {
        const m = /^o:(\d+)$/.exec(unb64(p.after));
        if (!m) return graphError({ code: 100, message: '(#100) Invalid cursor.', type: 'OAuthException' });
        offset = parseInt(m[1], 10);
      }
      const page = rows.slice(offset, offset + limit);
      const out = {
        data: page.map((t) => templateView(t, fields)),
        paging: { cursors: { before: b64('o:' + offset), after: b64('o:' + (offset + page.length)) } },
        summary: { total_count: rows.length, message_template_count: state.templates.length, message_template_limit: o.templateLimit, are_translations_complete: false },
      };
      if (offset + limit < rows.length) {
        const q = new URLSearchParams();
        q.set('after', out.paging.cursors.after);
        q.set('limit', String(limit));
        if (p.fields) q.set('fields', p.fields);
        if (p.status) q.set('status', p.status);
        if (p.name) q.set('name', p.name);
        if (o.pagingNextIncludesToken && call.token) q.set('access_token', call.token);
        const next = String(o.pagingOrigin).replace(/\/+$/, '') + '/' + GRAPH_VERSION + '/' + call.id + '/message_templates?' + q.toString();
        pagingIssued.add(next);
        out.paging.next = next;
      }
      return ok(out);
    },

    deleteTemplate(call) {
      if (!isWaba(call.id)) return nodeError('delete', call.id);
      const p = call.params || {};
      if (!p.name) return graphError({ code: 100, message: '(#100) name is required.', type: 'OAuthException' });
      const before = state.templates.length;
      state.templates = state.templates.filter((t) => !(t.name === p.name && (!p.hsm_id || t.id === p.hsm_id)));
      if (state.templates.length === before) return graphError({ code: 100, message: '(#100) Template not found.', type: 'OAuthException' });
      return ok({ success: true });
    },

    sendMessage(call) {
      const phone = phoneById(call.id);
      if (!phone) return nodeError('post', call.id);
      const d = call.data || {};
      const bad = (m) => graphError({ code: 100, message: '(#100) ' + m, type: 'OAuthException' });
      if (d.messaging_product !== 'whatsapp') return bad('The parameter messaging_product is required.');
      if (typeof d.to !== 'string' || !/^\+?\d{6,20}$/.test(d.to)) return bad('Invalid parameter: to.');
      if (phone.status !== 'CONNECTED') {
        // UNVERIFIED code meaning (AU4 6.3 table: 133010 not_registered).
        return graphError({ code: 133010, message: 'Phone number not registered', type: 'OAuthException' });
      }
      if (d.type === 'template') {
        const tpl = d.template || {};
        if (typeof tpl.name !== 'string' || !tpl.name || !tpl.language || typeof tpl.language.code !== 'string') return bad('Invalid parameter: template.');
        if (o.enforceApproved) {
          const found = state.templates.find((t) => t.name === tpl.name && t.language === tpl.language.code && t.status === 'APPROVED');
          if (!found) return graphError({ code: 132001, message: 'Template name does not exist in the translation', type: 'OAuthException' });
        }
      }
      const id = 'wamid.FIXTURE' + String(state.nextMessageId++).padStart(4, '0');
      state.sentMessages.push({ id, to: d.to, type: d.type, template: clone(d.template), text: clone(d.text), phoneId: call.id, token: call.token });
      return ok({ messaging_product: 'whatsapp', contacts: [{ input: d.to, wa_id: String(d.to).replace(/^\+/, '') }], messages: [{ id }] });
    },
  };

  const NEEDS_MERCHANT_TOKEN = new Set(['getPhone', 'getWaba', 'getBusiness', 'getNode', 'postNode', 'badMethod', 'listPhones', 'register', 'subscribe', 'listSubscribed', 'unsubscribe', 'listClientWabas', 'setDisplayName', 'requestCode', 'verifyCode', 'createTemplate', 'listTemplates', 'deleteTemplate', 'sendMessage']);

  // ------------------------------------------------------------------ the HTTP port
  async function request(config = {}) {
    const method = String(config.method || 'GET').toUpperCase();
    const parsed = parseUrl(config.url, config.baseURL);
    const params = Object.assign({}, parsed.query, config.params || {});
    const data = bodyOf(config.data);
    const headers = Object.assign({}, config.headers || {});
    const authorization = headerGet(headers, 'authorization');
    let token = null;
    let tokenSource = null;
    const bearer = typeof authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
    if (bearer) { token = bearer[1]; tokenSource = 'header'; }
    else if (typeof params.access_token === 'string') { token = params.access_token; tokenSource = 'param'; }
    else if (data && typeof data.access_token === 'string') { token = data.access_token; tokenSource = 'body'; }

    const foreign = parsed.origin !== GRAPH_ORIGIN;
    const r = foreign ? { name: 'foreign' } : route(method, parsed.path);
    const call = {
      seq: calls.length + 1,
      name: r.name,
      id: r.id,
      method,
      path: parsed.path,
      version: parsed.version,
      origin: parsed.origin,
      url: parsed.href,
      params,
      data,
      headers,
      authorization,
      token,
      tokenSource,
      tokenKind: kindOfToken(token),
      viaPaging: pagingIssued.has(parsed.href),
      foreign,
      timeout: config.timeout,
      status: undefined,
      errorCode: undefined,
      errorSubcode: undefined,
      networkError: undefined,
    };
    calls.push(call);

    if (o.delayMs > 0) await new Promise((res) => setTimeout(res, o.delayMs));

    let outcome;
    if (foreign) {
      outcome = { reject: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND ' + new URL(parsed.href).hostname } };
    } else {
      for (let i = 0; i < interceptors.length && !outcome; i += 1) {
        const ic = interceptors[i];
        if (!ic.test(call)) continue;
        const res = normalise(ic.respond, call);
        if (res === undefined) continue;
        ic.used += 1;
        if (ic.used >= ic.times) interceptors.splice(i, 1);
        call.scenario = ic.label;
        outcome = res;
      }
      if (!outcome) {
        if (NEEDS_MERCHANT_TOKEN.has(r.name)) {
          if (!token) outcome = graphError({ code: 104, message: 'An access token is required to request this resource.', type: 'OAuthException', status: 400 });
          else if (call.tokenKind !== 'merchant') outcome = graphError({ code: 190, message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException' });
        }
        if (!outcome) outcome = handlers[r.name](call);
      }
    }

    if (outcome.reject) {
      call.networkError = outcome.reject.code;
      const err = Object.assign(new Error(outcome.reject.message), { code: outcome.reject.code });
      // The port contract: rejects with { code, message }. A real Error keeps stack traces useful.
      throw err;
    }
    call.status = outcome.status;
    const e = outcome.data && outcome.data.error;
    if (e) { call.errorCode = e.code; call.errorSubcode = e.error_subcode; }
    return { status: outcome.status, data: clone(outcome.data), headers: Object.assign({}, outcome.headers) };
  }

  const http = {
    request,
    get: (url, config) => request(Object.assign({}, config, { method: 'GET', url })),
    post: (url, data, config) => request(Object.assign({}, config, { method: 'POST', url, data })),
    delete: (url, config) => request(Object.assign({}, config, { method: 'DELETE', url })),
  };

  // ------------------------------------------------------------------ scriptable interception
  function addInterceptor(matcher, respond, opts, label) {
    const ic = { test: compileMatcher(matcher), respond, times: (opts && opts.times) === undefined ? 1 : opts.times, used: 0, label: label || 'on' };
    interceptors.push(ic);
    return () => { const i = interceptors.indexOf(ic); if (i !== -1) interceptors.splice(i, 1); };
  }
  /** Register a custom responder. matcher: endpoint name | path substring | RegExp | {name,method,path,token,where} | fn(call). */
  function on(matcher, responder, opts) { return addInterceptor(matcher, responder, Object.assign({ times: Infinity }, opts), 'on'); }
  /** Make the next `times` (default 1) calls matching `name` fail with `response`. */
  function failNext(name, response, opts) { return addInterceptor(name, response, opts, 'failNext:' + (typeof name === 'string' ? name : 'matcher')); }

  const merchantCall = (c) => c.tokenKind === 'merchant';
  const errOnly = (spec) => () => graphError(spec);

  const scenarios = {
    /** Clear every pending scenario / failNext / on(): back to the healthy default behaviour. */
    happy() { interceptors.length = 0; return api; },
    /** Next exchange: 400 code 100 (code used twice or older than 30 s). {subcode36008:true} gives the redirect_uri variant. */
    codeExpired(opts) {
      const o2 = opts || {};
      addInterceptor('exchange', errOnly(o2.subcode36008
        ? { code: 100, subcode: 36008, message: 'Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request' }
        : { code: 100, message: 'Invalid verification code format.' }), o2, 'codeExpired');
      return api;
    },
    /** Every call using the merchant token fails 400 190/463 (persistent; pass {times:n} to limit). debug_token then reports is_valid:false. */
    token190(opts) {
      const times = (opts && opts.times) === undefined ? Infinity : opts.times;
      addInterceptor(merchantCall, oauthExpired, { times }, 'token190');
      addInterceptor((c) => c.name === 'debugToken' && state.validTokens.has(c.params && c.params.input_token) && c.tokenKind === 'app',
        () => ({ status: 200, data: { data: { app_id: o.appId, type: 'SYSTEM_USER', application: 'WaFlow', is_valid: false, scopes: [], error: { code: 190, subcode: 463, message: 'Error validating access token: Session has expired' } } } }),
        { times }, 'token190:debug');
      return api;
    },
    /** Next register: 400 code 133016 (register/deregister limit). */
    register133016(opts) {
      addInterceptor('register', errOnly({ code: 133016, message: 'Account register/deregister rate limit reached. Try again in 72 hours.', type: 'OAuthException' }), opts, 'register133016');
      return api;
    },
    /** Next template create: 400 code 100 / subcode 2388024 (duplicate name for that language). */
    duplicateTemplate(opts) {
      addInterceptor('createTemplate', errOnly({ code: 100, subcode: 2388024, message: '(#100) Invalid parameter', title: 'Message template already exists', userMsg: 'Content in this language already exists for this template name.' }), opts, 'duplicateTemplate');
      return api;
    },
    /** Next template create comes back with a different category (Meta re-categorises UTILITY as MARKETING). Stored too. */
    recategorized(category, opts) {
      addInterceptor('createTemplate', (call) => {
        const res = handlers.createTemplate(call);
        if (res.status === 200) {
          const t = state.templates.find((x) => x.id === res.data.id);
          t.category = category || 'MARKETING';
          res.data.category = t.category;
        }
        return res;
      }, opts, 'recategorized');
      return api;
    },
    /** From now on the WABA has no phone number (FINISH_ONLY_WABA). Persistent until addPhone(). */
    finishOnlyWaba() { state.phones = []; return api; },
    /** name_status / new_name_status are silently absent from every phone response (AU4: beta field). */
    nameStatusMissing() { state.omitNameStatus = true; return api; },
    /** Node GETs answer 400 code 100 naming `field` (persistent): drives the field-negotiation retry. */
    fieldRejected(field) { state.rejectFields.add(field); return api; },
    /** Next subscribe: 400 with {code: 200 (default) | 190 | 100}. */
    subscribeFails(opts) {
      const code = (opts && opts.code) || 200;
      addInterceptor('subscribe', errOnly({ code, subcode: code === 190 ? 463 : undefined, message: code === 200 ? '(#200) Requires whatsapp_business_management permission' : code === 190 ? 'Error validating access token' : '(#100) Invalid WABA id' }), opts, 'subscribeFails');
      return api;
    },
    /** Next matching call (default: any): 400 with the rate-limit code 4 (default) or 17 (or 80007 / 613 ...). */
    rateLimited(code, opts) {
      const c = code || 4;
      const match = (opts && opts.match) || (() => true);
      addInterceptor(match, errOnly({ code: c, status: (opts && opts.status) || 400, message: '(#' + c + ') Application request limit reached', type: 'OAuthException' }), opts, 'rateLimited:' + c);
      return api;
    },
    /** Next matching call (default: any) rejects with a network error {code (default ECONNRESET), message}. */
    networkDrop(opts) {
      const code = (opts && opts.code) || 'ECONNRESET';
      const match = (opts && opts.match) || (() => true);
      addInterceptor(match, () => ({ networkError: { code, message: code === 'ETIMEDOUT' || code === 'ECONNABORTED' ? 'timeout of ' + 20000 + 'ms exceeded' : 'socket hang up' } }), opts, 'networkDrop:' + code);
      return api;
    },
    /** Next matching call (default: any call with the merchant token): 400 permission error code 200 (or 10 / 2xx). */
    permissionMissing(code, opts) {
      const c = code || 200;
      const match = (opts && opts.match) || merchantCall;
      addInterceptor(match, errOnly({ code: c, message: '(#' + c + ') Requires whatsapp_business_management permission to manage the object', type: 'OAuthException' }), opts, 'permissionMissing:' + c);
      return api;
    },
    /** Next template/text message send: 400 code 131042 (payment issue; meaning UNVERIFIED in AU4). */
    paymentMissing(opts) {
      addInterceptor('sendMessage', errOnly({ code: 131042, message: 'Business eligibility payment issue', type: 'OAuthException' }), opts, 'paymentMissing');
      return api;
    },
  };

  // ------------------------------------------------------------------ state helpers for tests
  const api = {
    http,
    calls,
    on,
    failNext,
    reset() {
      calls.length = 0;
      interceptors.length = 0;
      pagingIssued.clear();
      state = buildState();
      return api;
    },
    scenarios,
    /** Ids and secrets of this fake (all dummy). */
    ids: { appId: o.appId, appSecret: o.appSecret, appToken: appToken(), businessId: o.businessId, wabaId: o.wabaId, phoneId: o.phoneId, merchantToken: o.merchantToken, platformToken: o.platformToken },
    get state() { return state; },
    callsTo: (name) => calls.filter((c) => c.name === name),
    lastCall: (name) => { const l = name ? calls.filter((c) => c.name === name) : calls; return l[l.length - 1]; },
    foreignCalls: () => calls.filter((c) => c.foreign),
    pending: () => interceptors.map((i) => i.label),
    sentMessages: () => clone(state.sentMessages),
    templates: () => clone(state.templates),
    /** Browser-side `message` payload for an Embedded Signup session (AU4 section 1.2). */
    session(event) {
      const ev = event || 'FINISH';
      if (ev === 'FINISH_ONLY_WABA') return { type: 'WA_EMBEDDED_SIGNUP', event: ev, data: { waba_id: o.wabaId, business_id: o.businessId } };
      if (ev === 'CANCEL') return { type: 'WA_EMBEDDED_SIGNUP', event: ev, data: { current_step: 'PHONE_NUMBER_SETUP' } };
      return { type: 'WA_EMBEDDED_SIGNUP', event: ev, data: { phone_number_id: o.phoneId, waba_id: o.wabaId, business_id: o.businessId } };
    },

    // --- state mutators (each returns the fake) ---
    setVerification(status, opts) {
      state.verificationStatus = status;
      state.portfolioVerification = opts && opts.portfolio ? opts.portfolio : status;
      return api;
    },
    setTier(tier) { state.tier = tier; return api; },
    setHealth(level, entities) { state.health = level; state.healthEntities = entities; return api; },
    setSubscribed(flag, wabaId) { if (flag) state.subscribed.add(wabaId || o.wabaId); else state.subscribed.delete(wabaId || o.wabaId); return api; },
    setPrimaryFundingId(id) { state.primaryFundingId = id === null ? undefined : id; return api; },
    setTokenExpiry(sec) { state.tokenExpiresAtSec = sec; return api; },
    setScopes(scopes) { state.scopes = scopes.slice(); return api; },
    setRejectFields(list) { state.rejectFields = new Set(list || []); return api; },
    /** Patch a phone (default: the first) e.g. setPhone({ status: 'PENDING' }). */
    setPhone(patch, idOrIndex) {
      const p = typeof idOrIndex === 'string' ? phoneById(idOrIndex) : state.phones[idOrIndex || 0];
      if (!p) throw new Error('setPhone: no such phone');
      Object.assign(p, patch);
      return api;
    },
    /** Display-name review outcome helpers (the webhook is what a real Meta would also send). */
    setNameStatus(status, patch) { return api.setPhone(Object.assign({ name_status: status }, patch || {})); },
    approveDisplayName() {
      const p = state.phones[0];
      p.verified_name = p.new_display_name || p.verified_name;
      p.name_status = 'APPROVED'; p.new_display_name = undefined; p.new_name_status = undefined;
      return api;
    },
    declineDisplayName() { const p = state.phones[0]; p.name_status = 'DECLINED'; p.new_name_status = 'DECLINED'; return api; },
    addPhone(spec) {
      const i = state.phones.length;
      state.phones.push(Object.assign({
        id: o.phoneId + (i ? '_' + i : ''), display_phone_number: o.displayNumber, verified_name: o.verifiedName, name_status: o.nameStatus,
        quality_rating: o.qualityRating, code_verification_status: o.codeVerificationStatus, status: o.phoneStatus, platform_type: o.platformType,
        is_on_biz_app: o.isOnBizApp, throughput: { level: 'STANDARD' }, last_onboarded_time: new Date((clock.sec() + i * 60) * 1000).toISOString(), nameEdits: 0,
      }, spec || {}));
      return api;
    },
    /** Template status progression. reason is stored as rejected_reason for REJECTED. */
    setTemplateStatus(name, language, status, reason) {
      if (!TEMPLATE_STATUSES.includes(status)) throw new Error('setTemplateStatus: unknown status ' + status);
      const t = state.templates.find((x) => x.name === name && x.language === language);
      if (!t) throw new Error('setTemplateStatus: no template ' + name + '/' + language);
      t.status = status;
      if (status === 'REJECTED') t.rejected_reason = reason || 'INVALID_FORMAT';
      else if (status === 'APPROVED') delete t.rejected_reason;
      else if (reason !== undefined) t.rejected_reason = reason;
      return clone(t);
    },
    setTemplateCategory(name, language, category) {
      const t = state.templates.find((x) => x.name === name && x.language === language);
      if (!t) throw new Error('setTemplateCategory: no template ' + name + '/' + language);
      t.previous_category = t.category; t.category = category;
      return clone(t);
    },
    approveAllTemplates() { state.templates.forEach((t) => { if (t.status === 'PENDING') t.status = 'APPROVED'; }); return api; },

    /** Inbound webhook helpers (this fake never delivers; tests POST these to the app). */
    webhook: {
      sign(rawBody, secret) {
        return 'sha256=' + crypto.createHmac('sha256', secret || o.appSecret).update(rawBody).digest('hex');
      },
      envelope(field, value, wabaId) {
        return { object: 'whatsapp_business_account', entry: [{ id: wabaId || o.wabaId, time: clock.sec(), changes: [{ field, value }] }] };
      },
      templateStatus(name, language, event, reason) {
        const t = state.templates.find((x) => x.name === name && x.language === language);
        return api.webhook.envelope('message_template_status_update', {
          event, message_template_id: t ? Number(t.id) : 0, message_template_name: name, message_template_language: language,
          reason: reason || 'NONE', message_template_category: t ? t.category : 'UTILITY',
        });
      },
    },

    /**
     * Throws if any of `secrets` appears where it should not. Scans every recorded call's url,
     * path, params, data and headers, EXCEPT the protocol-mandated places: the Authorization
     * bearer (when the secret IS that call's token), exchange `code`/`client_secret`, debug_token
     * `input_token`, register `pin`. `extra` (optional array of strings/objects: captured log
     * lines, error messages, response bodies) is scanned with no exemption.
     * Only the secrets you pass are checked; secrets shorter than 4 chars are refused.
     */
    assertNoLeak(secrets, extra) {
      const leaks = api.findLeaks(secrets, extra);
      if (leaks.length) throw new Error('secret leaked: ' + leaks.join('; '));
      return true;
    },
    findLeaks(secrets, extra) {
      const leaks = [];
      (secrets || []).forEach((s, k) => {
        if (typeof s !== 'string' || s.length < 4) throw new Error('assertNoLeak: secret #' + k + ' missing or too short to scan');
      });
      const enc = (v) => encodeURIComponent(String(v));
      calls.forEach((c) => {
        (secrets || []).forEach((s, k) => {
          const exempt = (loc) => {
            if ((s === c.token || (c.tokenKind === 'app' && c.token.includes(s))) && (loc === 'header.authorization' || loc === 'params.access_token' || loc === 'data.access_token')) return true;
            if (c.name === 'exchange' && ((loc === 'params.code' && c.params.code === s) || (loc === 'params.client_secret' && c.params.client_secret === s))) return true;
            if (c.name === 'debugToken' && loc === 'params.input_token' && c.params.input_token === s) return true;
            if (c.name === 'register' && loc === 'data.pin' && c.data && String(c.data.pin) === s) return true;
            return false;
          };
          const hit = (loc, text) => {
            if (typeof text !== 'string' || !text.includes(s)) return;
            if (!exempt(loc)) leaks.push('secret #' + k + ' (len ' + s.length + ') in calls[' + (c.seq - 1) + '] ' + c.name + ' ' + loc);
          };
          // url: remove the protocol-mandated query parameters before scanning
          let urlText = c.url;
          Object.keys(c.params || {}).forEach((key) => {
            const v = c.params[key];
            if (exempt('params.' + key)) {
              urlText = urlText.split(key + '=' + enc(v)).join('').split(key + '=' + v).join('');
            }
          });
          hit('url', urlText);
          hit('path', c.path);
          Object.keys(c.params || {}).forEach((key) => hit('params.' + key, String(c.params[key])));
          if (c.data !== undefined) {
            if (typeof c.data === 'object' && c.data !== null) Object.keys(c.data).forEach((key) => hit('data.' + key, typeof c.data[key] === 'string' ? c.data[key] : JSON.stringify(c.data[key])));
            else hit('data', String(c.data));
          }
          Object.keys(c.headers || {}).forEach((h) => hit('header.' + h.toLowerCase(), String(c.headers[h])));
        });
      });
      (extra || []).forEach((item, i) => {
        const text = typeof item === 'string' ? item : (item instanceof Error ? item.message + ' ' + (item.stack || '') : JSON.stringify(item));
        (secrets || []).forEach((s, k) => {
          if (typeof text === 'string' && text.includes(s)) leaks.push('secret #' + k + ' (len ' + s.length + ') in extra[' + i + ']');
        });
      });
      return leaks;
    },
    /** Distinct tokens seen, by kind: { merchant:[], app:[], platform:[], unknown:[] }. */
    tokensUsed() {
      const out = { merchant: new Set(), app: new Set(), platform: new Set(), unknown: new Set() };
      calls.forEach((c) => { if (c.token && out[c.tokenKind]) out[c.tokenKind].add(c.token); });
      return { merchant: [...out.merchant], app: [...out.app], platform: [...out.platform], unknown: [...out.unknown] };
    },
    /** Throws if `token` was ever presented to Graph (use with the platform token). */
    assertNeverUsedToken(token) {
      const bad = calls.filter((c) => c.token === token);
      if (bad.length) throw new Error('forbidden token used in ' + bad.length + ' call(s): ' + bad.map((c) => '#' + c.seq + ' ' + c.name).join(', '));
      return true;
    },
    /** Throws unless every merchant-scoped call (all but exchange/debugToken/foreign) carried exactly `token`. */
    assertMerchantTokenOnly(token) {
      const bad = calls.filter((c) => !['exchange', 'debugToken', 'foreign'].includes(c.name) && c.token !== token);
      if (bad.length) throw new Error('merchant-scoped call(s) without the merchant token: ' + bad.map((c) => '#' + c.seq + ' ' + c.name).join(', '));
      return true;
    },
    assertNoForeignCalls() {
      const f = api.foreignCalls();
      if (f.length) throw new Error('call(s) to a non-Graph origin: ' + f.map((c) => c.origin).join(', '));
      return true;
    },
  };
  return api;
}

module.exports = { createFakeGraph, graphError, GRAPH_ORIGIN, GRAPH_VERSION, TEMPLATE_STATUSES };
