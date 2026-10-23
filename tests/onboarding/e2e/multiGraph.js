'use strict';
// A registry of FakeGraph instances behind ONE HTTP port (task I1b). The real server talks to Graph through the
// axios adapter bridge below; every call is routed to the fake that owns the merchant token it carries, so several
// seeded workspaces can each have their own WhatsApp Business account, phone number and templates.
//   - merchant token  -> the fake that issued / knows it
//   - app token (exchange / debug_token) -> the fake that owns the input token, else the CURRENT TARGET fake
//   - the platform token (WA_TOKEN: the legacy senders) -> a tiny platform responder that RECORDS the call
//   - anything else -> the target fake (it answers 190 / 104 exactly like Graph)
// Nothing here opens a socket; non-Graph origins reject ENOTFOUND (recorded by the fake as `foreign`).

const { createFakeGraph, GRAPH_ORIGIN } = require('../_fixtures');

const DEFAULT_BASE = Object.freeze({ appId: 'APP_ID_FIXTURE', appSecret: 'APP_SECRET_FIXTURE_0123456789abcdef' });
const PLATFORM_TOKEN_DEFAULT = 'EAAPLATFORMdummyTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz';

let idSeq = 0;
/** Unique Meta ids (WhatsAppClaim is cross-tenant: two workspaces can never share a WABA / phone id). */
function uniqueIds(prefix = '19') {
  idSeq += 1;
  const n = String(Date.now()).slice(-8) + String(idSeq).padStart(3, '0');
  return { wabaId: `${prefix}${n}1`, phoneId: `${prefix}${n}2`, businessId: `${prefix}${n}3` };
}

/** A fixed token per fake key (>= 40 characters so the production redaction heuristic is exercised). */
function tokenFor(key) {
  // hash of the WHOLE key: a plain prefix of a workspace id collides for two workspaces created close together (ObjectId counters)
  const safe = require('crypto').createHash('sha1').update(String(key)).digest('hex').slice(0, 24);
  return `EAAFXTmerchantTOKEN_${safe}_0123456789_abcdefghijklmnopqrstuvwxyz`;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function tokenOf(cfg) {
  const headers = cfg.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  const auth = key ? headers[key] : null;
  const bearer = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  if (bearer) return bearer[1];
  if (cfg.params && typeof cfg.params.access_token === 'string') return cfg.params.access_token;
  let q = null;
  try { q = new URL(String(cfg.url || ''), GRAPH_ORIGIN).searchParams.get('access_token'); } catch (_) { q = null; }
  return q;
}

/**
 * @param {{clock?:object, platformToken?:string, base?:object}} [opts]
 */
function createMultiGraph(opts = {}) {
  const platformToken = opts.platformToken || PLATFORM_TOKEN_DEFAULT;
  const base = Object.assign({}, DEFAULT_BASE, opts.base || {});
  const fakes = new Map();
  const platformCalls = [];
  let targetKey = null;
  let platformSeq = 0;

  function add(key, options = {}) {
    if (fakes.has(key)) throw new Error(`multiGraph: fake '${key}' already exists`);
    const g = createFakeGraph(Object.assign({}, base, { clock: opts.clock, platformToken, merchantToken: tokenFor(key) }, uniqueIds(), options));
    fakes.set(key, g);
    if (!targetKey) targetKey = key;
    return g;
  }
  const get = (key) => fakes.get(key) || null;
  function target() { return targetKey ? fakes.get(targetKey) : null; }
  /** Make `key` the fake that answers the next code exchanges (the "fresh connect" fake). */
  function setTarget(key) {
    if (!fakes.has(key)) throw new Error(`multiGraph: no fake '${key}'`);
    targetKey = key;
    return fakes.get(key);
  }
  /** A brand-new fake with unique Meta ids and the current target (what a new merchant connecting right now meets). */
  function newTarget(key, options = {}) {
    const g = add(key, options);
    setTarget(key);
    return g;
  }

  function ownerOf(token) {
    if (!token) return null;
    for (const [key, g] of fakes) if (g.state.validTokens.has(token) || g.ids.merchantToken === token) return key;
    return null;
  }

  function platformRespond(cfg) {
    platformSeq += 1;
    const method = String(cfg.method || 'GET').toUpperCase();
    let pathname = '';
    try { pathname = new URL(String(cfg.url || ''), GRAPH_ORIGIN).pathname; } catch (_) { pathname = String(cfg.url || ''); }
    let data = cfg.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { /* keep the string */ } }
    const rec = { seq: platformSeq, method, path: pathname, to: data && data.to, type: data && data.type, body: clone(data) };
    platformCalls.push(rec);
    if (method === 'POST' && /\/messages$/.test(pathname)) {
      const to = String((data && data.to) || '');
      return { status: 200, data: { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to.replace(/^\+/, '') }], messages: [{ id: `wamid.PLATFORM${String(platformSeq).padStart(4, '0')}` }] }, headers: {} };
    }
    return { status: 200, data: { data: [], success: true }, headers: {} };
  }

  /** The Graph HTTP port (INTERFACES 0.2): resolves for every status, rejects { code, message } on a network failure. */
  async function request(cfg = {}) {
    const token = tokenOf(cfg);
    if (token && token === platformToken) return platformRespond(cfg);
    let key = ownerOf(token);
    if (!key) {
      // app token calls: debug_token follows its input token, everything else goes to the target
      const input = cfg.params && cfg.params.input_token;
      key = (input && ownerOf(input)) || targetKey;
    }
    const g = fakes.get(key);
    if (!g) throw Object.assign(new Error('multiGraph: no fake registered'), { code: 'ECONNRESET' });
    return g.http.request(cfg);
  }

  const calls = () => {
    const out = [];
    for (const [key, g] of fakes) g.calls.forEach((c) => out.push(Object.assign({ fake: key }, c)));
    return out.sort((a, b) => (a.fake === b.fake ? a.seq - b.seq : 0));
  };
  const callsTo = (name) => calls().filter((c) => c.name === name);
  const resetCalls = () => { for (const g of fakes.values()) g.calls.length = 0; platformCalls.length = 0; };

  return {
    http: { request },
    fakes, add, get, target, setTarget, newTarget, uniqueIds, tokenFor, ownerOf,
    platformToken, platformCalls, calls, callsTo, resetCalls,
    get targetKey() { return targetKey; },
  };
}

/**
 * Route every axios request of this process through `http` (the multiGraph port). Returns an `uninstall` function.
 * Network failures of the port (reject { code, message }) become AxiosErrors; a status that the request's own
 * validateStatus refuses becomes an AxiosError with a response (the legacy senders rely on that).
 */
function installAxiosAdapter(axios, http) {
  const previous = axios.defaults.adapter;
  const plainHeaders = (h) => {
    if (!h) return {};
    if (typeof h.toJSON === 'function') return h.toJSON();
    return Object.assign({}, h);
  };
  axios.defaults.adapter = async function bridgeAdapter(config) {
    let res;
    try {
      res = await http.request({
        method: config.method, url: config.url, baseURL: config.baseURL, params: config.params, data: config.data,
        headers: plainHeaders(config.headers), timeout: config.timeout,
      });
    } catch (e) {
      throw new axios.AxiosError((e && e.message) || 'network error', (e && e.code) || 'ECONNRESET', config, {});
    }
    const response = { data: res.data, status: res.status, statusText: String(res.status), headers: res.headers || {}, config, request: {} };
    if (typeof config.validateStatus === 'function' && !config.validateStatus(res.status)) {
      throw new axios.AxiosError(`Request failed with status code ${res.status}`, res.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, {}, response);
    }
    return response;
  };
  return function uninstall() { axios.defaults.adapter = previous; };
}

/** Methods of a fakeGraph that the control endpoint may call (state mutators + scenario helpers). */
const GRAPH_METHODS = Object.freeze([
  'setVerification', 'setTier', 'setHealth', 'setSubscribed', 'setPrimaryFundingId', 'setTokenExpiry', 'setScopes', 'setRejectFields',
  'setPhone', 'setNameStatus', 'approveDisplayName', 'declineDisplayName', 'addPhone', 'setTemplateStatus', 'setTemplateCategory',
  'approveAllTemplates', 'failNext', 'reset',
]);

/** Apply one control operation to a fake: { op: 'scenario'|'method', name, args }. Returns a JSON-safe result. */
function applyGraphOp(g, body) {
  const args = Array.isArray(body.args) ? body.args : [];
  if (body.op === 'scenario') {
    if (!g.scenarios || typeof g.scenarios[body.name] !== 'function') throw new Error(`unknown scenario '${body.name}'`);
    g.scenarios[body.name](...args);
    return { ok: true, pending: g.pending() };
  }
  if (body.op === 'method') {
    if (!GRAPH_METHODS.includes(body.name)) throw new Error(`method '${body.name}' is not allowed`);
    const r = g[body.name](...args);
    return { ok: true, result: r && r.http ? undefined : clone(r) };
  }
  throw new Error(`unknown graph op '${body.op}'`);
}

module.exports = { createMultiGraph, installAxiosAdapter, applyGraphOp, GRAPH_METHODS, uniqueIds, tokenFor, PLATFORM_TOKEN_DEFAULT, DEFAULT_BASE };
