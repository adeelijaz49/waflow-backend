'use strict';
// Shared machinery for englishUnchanged2.itest.js (the SECOND "English unchanged" characterisation
// suite). Not a test file. Only ever used against the THROWAWAY mongod (see ../_guard.js) with the
// axios adapter stubbed, so nothing leaves the machine and nothing real is touched.
//
// What it provides
//   * an axios adapter stub that records every outbound call (WhatsApp / Graph), answers with canned
//     replies (sequential, scenario-unique wamids) and can be told to FAIL selected calls
//   * scenario(): resets in-memory shopping state, runs a scenario, then records
//        calls    every outbound HTTP call
//        db       the documents CREATED OR CHANGED by the scenario (normalised: ids -> stable labels,
//                 dates -> <date>), keyed by label
//        returns  return values / error messages of the operations the scenario ran
//        http     status + body of the HTTP routes the scenario hit
//        logs     console.error / console.warn lines the code emitted (recorded, only asserted when ENG_STRICT_LOGS=1)
//     ENG_RECORD=1 writes them to a golden file (run on the pristine pre-Arabic backend); otherwise the
//     record is asserted equal to the golden - except where an explicit APPROVED difference applies.
//   * APPROVED differences, keyed by scenario name (see approvalFor()).
const { assertThrowawayDb } = require('../_guard'); assertThrowawayDb();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const axios = require('axios');
const mongoose = require('mongoose');

const RECORD = process.env.ENG_RECORD === '1';
const FLAG_ON = process.env.ENG_FLAG === 'on';
const KILL = process.env.LOCALIZATION_DISABLED === '1' || process.env.LOCALIZATION_DISABLED === 'true';
const STRICT_LOGS = process.env.ENG_STRICT_LOGS === '1';
const GOLDEN_FILE = process.env.ENG_GOLDEN_FILE || path.join(require('os').tmpdir(), 'englishUnchanged2.golden.json'); // large: kept OUT of the repo
const NEW_COLLECTION_RE = /^(customerlanguages|localesettings|localizedcampaigns|localizedsends|localizedtemplates|localizationadminlogs|producttranslations|userlocalepreferences|localized)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── shared mutable state ─────────────────────────────────────────────────────
const H = {
  app: null, W: null, token: null,
  calls: [], wamidSeq: 0, scenarioNo: 0,
  failRules: [], logs: { error: [], warn: [] },
  prevStrings: null, onScenarioStart: null,
  results: {}, golden: null,
  labels: new Map(), usedLabels: new Set(), last10: new Map(), timings: {},
};

// ── outbound HTTP stub ───────────────────────────────────────────────────────
function installAdapter() {
  axios.defaults.adapter = async (config) => {
    let body = config.data;
    if (body && typeof body.getBoundary === 'function') body = '<formdata>';
    else if (Buffer.isBuffer(body)) body = '<buffer>';
    else if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep string */ } }
    const rec = { method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body };
    if (config.params) { const { access_token, ...rest } = config.params; if (Object.keys(rest).length) rec.params = rest; }
    H.calls.push(rec);
    for (const rule of H.failRules) {
      if (rule.remaining !== 0 && rule.match(rec)) {
        if (rule.remaining > 0) rule.remaining -= 1;
        const response = { status: rule.status || 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message: rule.message || 'Meta stub rejected this call', code: rule.code || 131047, type: 'OAuthException' } } };
        throw new axios.AxiosError(`Request failed with status code ${response.status}`, 'ERR_BAD_REQUEST', config, {}, response);
      }
    }
    const isMsg = /\/messages$/.test(rec.url);
    let data;
    if (rec.method === 'GET' && config.params && config.params.fields === 'display_phone_number') data = { display_phone_number: '+1 555 000 0000', id: '111111111111111' };
    else if (rec.method === 'GET') data = config.responseType === 'arraybuffer' ? Buffer.from('x') : { data: [] };
    else if (isMsg) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.S${H.scenarioNo}_${++H.wamidSeq}` }] };
    else data = { id: `stub${H.scenarioNo}_${++H.wamidSeq}` };
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}

// call matchers for ctx.fail()
const isMessage = (rec) => /\/messages$/.test(rec.url) && rec.method === 'POST';
const isMsgType = (type) => (rec) => isMessage(rec) && rec.body && rec.body.type === type;
const isMsgTo = (to) => (rec) => isMessage(rec) && rec.body && rec.body.to === to;

// ── webhook payload builders ─────────────────────────────────────────────────
let msgSeq = 0;
function envelope(message, contactName) {
  return { object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '111111111111111' },
    contacts: [{ profile: { name: contactName || 'Test Contact' }, wa_id: message.from }],
    messages: [message],
  } }] }] };
}
const msgBase = (from) => ({ from, id: `wamid.IN2_${++msgSeq}`, timestamp: '1760000000' });
const ctxOf = (ctxId) => (ctxId ? { context: { from: '15550000000', id: ctxId } } : {});
const textMsg = (from, body) => ({ ...msgBase(from), type: 'text', text: { body } });
const tplBtn = (from, payload, text, ctxId) => ({ ...msgBase(from), type: 'button', button: { payload, text: text || 'Button' }, ...ctxOf(ctxId) });
const ibtn = (from, id, title, ctxId) => ({ ...msgBase(from), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: title || 'Button' } }, ...ctxOf(ctxId) });
const lrow = (from, id, title, ctxId) => ({ ...msgBase(from), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: title || 'Row', description: 'row' } }, ...ctxOf(ctxId) });
const statusPayload = (statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '111111111111111' }, statuses } }] }] });

// ── snapshot / normalisation ─────────────────────────────────────────────────
async function rawSnapshot() {
  const db = mongoose.connection.db;
  const names = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !NEW_COLLECTION_RE.test(n) && !n.startsWith('system.')).sort();
  const docsList = await Promise.all(names.map((n) => db.collection(n).find({}).sort({ _id: 1 }).toArray()));
  const out = {};
  names.forEach((n, i) => { out[n] = docsList[i]; });
  return out;
}
function snapStrings(snap) {
  const out = {};
  for (const [coll, docs] of Object.entries(snap)) { out[coll] = {}; for (const d of docs) out[coll][String(d._id)] = JSON.stringify(d); }
  return out;
}
const HOT = ['customers', 'campaignmessages', 'orders', 'bookings', 'flowenrollments', 'whatsappmessages', 'timeslots', 'consentevents', 'referrals', 'referralcodes', 'vouchers', 'importjobs', 'promotions', 'flows', 'messagenodes', 'schedulerlocks'];
async function liteFingerprint() {
  const db = mongoose.connection.db;
  const [stats, ...latest] = await Promise.all([
    db.command({ dbStats: 1 }),
    ...HOT.map((n) => db.collection(n).find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).toArray()),
  ]);
  return crypto.createHash('md5').update([H.calls.length, stats.objects, stats.dataSize, stats.collections, ...latest.map((l) => String((l[0] && l[0].updatedAt) || ''))].join('|')).digest('hex');
}

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
// Labels are PERSISTENT and local to the scenario that created the document (coll#S<scenario>.<k>; fixtures coll#F<k>,
// customers customers:<phone>), so one extra/missing document in one scenario cannot shift the labels of later scenarios.
// New documents are ordered by creation time (then id), NOT by id alone: server-generated ids (upserts) and client-generated
// ids do not sort in creation order relative to each other.
const createdKey = (d) => new Date(d.createdAt || (d._id && d._id.getTimestamp ? d._id.getTimestamp() : 0)).getTime();
function assignLabels(snap, scenarioNo) {
  for (const [coll, allDocs] of Object.entries(snap)) {
    let k = 0;
    const docs = allDocs.filter((d) => !H.labels.has(String(d._id))).sort((a, b) => createdKey(a) - createdKey(b) || String(a._id).localeCompare(String(b._id)));
    for (const d of docs) {
      const id = String(d._id);
      if (H.labels.has(id)) continue;
      let label = coll === 'customers' && d.phone && !/^deleted-/.test(String(d.phone)) ? `customers:${d.phone}` : `${coll}#${scenarioNo === 0 ? 'F' : `S${scenarioNo}.`}${k}`;
      k += 1;
      if (H.usedLabels.has(label)) { let j = 2; while (H.usedLabels.has(`${label}~${j}`)) j += 1; label = `${label}~${j}`; }
      H.usedLabels.add(label);
      H.labels.set(id, label);
      H.last10.set(id.slice(-10), label);
    }
  }
}
function buildMaps(snap, scenarioNo, extraIds) {
  assignLabels(snap, scenarioNo);
  const idMap = new Map(H.labels);
  for (const [id, label] of Object.entries(extraIds || {})) idMap.set(id, label);
  // referral / voucher codes are random: replace them by the label of the document that holds them
  const subs = [];
  for (const coll of ['referralcodes', 'vouchers']) {
    (snap[coll] || []).forEach((d) => { if (d.code) subs.push([String(d.code), `<code:${idMap.get(String(d._id))}>`]); });
  }
  return { idMap, last10: H.last10, subs };
}
// Status-callback timestamps in the scenarios are fixed constants (unix 1760000000..1760000999 = 2025-10-09), so a date on that day is
// DETERMINISTIC and is compared as-is (it proves which of several out-of-order callbacks won). Every other date is wall-clock: <date>.
const FIXED_DAY = '2025-10-09';
const normDate = (iso) => (String(iso).startsWith(FIXED_DAY) ? `<fixed:${iso}>` : '<date>');
function normString(s, M) {
  let out = s.replace(ISO_RE, (m) => normDate(m));
  for (const [from, to] of M.subs) if (out.includes(from)) out = out.split(from).join(to);
  out = out.replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{24}(?![0-9a-fA-F])/g, (m) => M.idMap.get(m.toLowerCase()) || '<oid>');
  out = out.replace(/\bdemo_(?=[0-9a-z]*\d)[0-9a-z]{14,18}\b/g, '<demo-wamid>').replace(/\bdemocarousel_\d{10,14}_[0-9a-z]+/g, '<demo-wamid>');
  out = out.replace(/\bint_[0-9a-z]{9,16}\b/g, 'int_<id>');
  out = out.replace(/waflow_flow_([0-9a-f]{10})/g, (m, h) => `waflow_flow_<${M.last10.get(h) || 'node'}>`);
  return out;
}
function norm(value, M) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '<invalid-date>' : normDate(value.toISOString());
  if (Buffer.isBuffer(value)) return '<buffer>';
  if (value && value._bsontype === 'ObjectId') return M.idMap.get(String(value)) || '<oid>';
  if (Array.isArray(value)) return value.map((v) => norm(v, M));
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value).sort()) { if (k === '__v') continue; o[k] = norm(value[k], M); }
    return o;
  }
  if (typeof value === 'string') return normString(value, M);
  return value;
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function buildRecord(after, beforeStrings, extra) {
  const M = buildMaps(after, extra.scenarioNo, extra.extraIds);
  const db = {};
  for (const [coll, docs] of Object.entries(after)) {
    const prev = beforeStrings[coll] || {};
    for (const d of docs) {
      if (prev[String(d._id)] !== JSON.stringify(d)) { (db[coll] = db[coll] || {})[M.idMap.get(String(d._id))] = norm(d, M); }
    }
  }
  const deleted = {};
  for (const [coll, prev] of Object.entries(beforeStrings)) {
    const now = new Set((after[coll] || []).map((d) => String(d._id)));
    const n = Object.keys(prev).filter((id) => !now.has(id)).length;
    if (n) deleted[coll] = n;
  }
  if (Object.keys(deleted).length) db.__deleted = deleted;
  const rec = {
    calls: norm(clone(extra.calls), M),
    db,
    returns: norm(clone(extra.returns), M),
    http: norm(clone(extra.http), M),
    logs: norm(clone(extra.logs), M),
  };
  if (extra.meta) rec.meta = norm(clone(extra.meta), M);
  return rec;
}

// ── waiting for the (fire-and-forget) webhook handlers to finish ─────────────
async function quiet(first = 200, poll = 60, stableNeeded = 3) {
  await sleep(first);
  let last = null; let stable = 0;
  for (let i = 0; i < 80 && stable < stableNeeded; i++) {
    const fp = await liteFingerprint();
    if (fp === last) stable += 1; else { stable = 0; last = fp; }
    await sleep(poll);
  }
}
const settle = () => quiet(150, 60, 2);

// ── scenario runner ──────────────────────────────────────────────────────────
function resetState() {
  const st = require('../../../../utils/state');
  for (const m of Object.values(st)) if (m && typeof m.clear === 'function') m.clear();
}

let phoneSeq = 0;
function makeCtx(state) {
  const Customer = require('../../../../models/Customer');
  const ctx = {
    W: H.W,
    created: [],
    async cust(label, fields) {
      phoneSeq += 1;
      const phone = `1555020${String(phoneSeq).padStart(4, '0')}`;
      const c = await Customer.create({ firstname: label, lastname: 'Eng', phone, workspaceId: (fields && fields.workspaceId) || H.W, ...(fields || {}) });
      ctx.created.push(c);
      return c;
    },
    async post(payload) { await request(H.app).post('/webhook').send(payload); await quiet(); },
    async stripeEvent(event) {
      const res = await request(H.app).post('/stripe-webhook').set('Content-Type', 'application/json').send(JSON.stringify(event));
      state.http.push({ method: 'POST', url: '/stripe-webhook', status: res.status, body: res.text });
      await quiet();
    },
    settle,
    quiet,
    // run an operation, keep its return value (or error message) in the record
    async run(name, fn) {
      try { const v = await fn(); state.returns[name] = { ok: clone(v === undefined ? null : v) }; return v; }
      catch (e) { state.returns[name] = { error: String(e && e.message) }; return undefined; }
    },
    ret(name, value) { state.returns[name] = clone(value === undefined ? null : value); },
    async http(method, url, body, opts = {}) {
      let r = request(H.app)[method.toLowerCase()](url);
      if (opts.bearer) r = r.set('Authorization', `Bearer ${opts.bearer}`);
      else if (!opts.noAuth) r = r.set('Authorization', `Bearer ${H.token}`);
      if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) r = r.set(k, v);
      if (opts.attach) r = r.field(opts.fields || {}).attach(opts.attach.name, opts.attach.buffer, opts.attach.filename);
      else if (body !== undefined) r = r.send(body);
      const res = await r;
      const isJson = /json/.test(res.headers['content-type'] || '');
      state.http.push({ method: method.toUpperCase(), url, status: res.status, body: isJson ? res.body : res.text, ...(res.headers.location ? { location: res.headers.location } : {}) });
      if (opts.settle === true) await settle();
      return res;
    },
    // make selected outbound calls fail: ctx.fail(match, { times, status, code, message })
    fail(match, opts = {}) { H.failRules.push({ match, remaining: opts.times == null ? -1 : opts.times, status: opts.status, code: opts.code, message: opts.message }); },
    clearFail() { H.failRules = []; },
    randomConst(v) { state.randomSpy = jest.spyOn(Math, 'random').mockReturnValue(v); },
    afterRecord(fn) { state.after.push(fn); },
    meta(obj) { state.meta = { ...(state.meta || {}), ...obj }; },
    extraIds(map) { Object.assign(state.extraIds, map); },
    async cm(customer) { return require('../../../../models/CampaignMessage').findOne({ customer: customer._id }).sort({ _id: -1 }); },
    async cmAll(customer) { return require('../../../../models/CampaignMessage').find({ customer: customer._id }).sort({ _id: 1 }); },
  };
  return ctx;
}

function scenario(name, fn, opts = {}) {
  test(name, async () => {
    if (Object.prototype.hasOwnProperty.call(H.results, name)) throw new Error(`duplicate scenario name: ${name}`);
    H.scenarioNo += 1;
    const t0 = Date.now();
    resetState();
    H.calls = []; H.wamidSeq = 0; H.failRules = []; H.logs = { error: [], warn: [] };
    if (H.onScenarioStart) H.onScenarioStart(H.scenarioNo);
    if (!H.prevStrings) { const s0 = await rawSnapshot(); assignLabels(s0, 0); H.prevStrings = snapStrings(s0); }
    const state = { returns: {}, http: [], meta: null, after: [], randomSpy: null, extraIds: {} };
    const ctx = makeCtx(state);
    try {
      await fn(ctx);
      await settle();
    } finally {
      if (state.randomSpy) state.randomSpy.mockRestore();
    }
    const after = await rawSnapshot();
    const rec = buildRecord(after, H.prevStrings, { scenarioNo: H.scenarioNo, calls: H.calls, returns: state.returns, http: state.http, logs: H.logs, meta: state.meta, extraIds: Object.assign({ [H.userId]: 'user:owner' }, state.extraIds) });
    H.results[name] = JSON.parse(JSON.stringify(rec));
    // fixture clean-up that must not show up in the next scenario's delta
    H.failRules = [];
    for (const f of state.after) await f(ctx);
    H.prevStrings = snapStrings(state.after.length ? await rawSnapshot() : after);

    H.timings[name] = Date.now() - t0;
    if (!RECORD) {
      if (!H.golden) H.golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
      const g = H.golden[name];
      expect(g).toBeDefined();
      const approve = approvalFor(name, opts);
      if (approve) approve(g, H.results[name]);
      else strictEqual(g, H.results[name]);
    }
  }, opts.timeout || 90000);
}

// FLAGGED_ONLY_HTTP: when the Arabic flag is ON (and the kill switch is off) a few HTTP bodies legitimately gain EXACTLY these additions; they are
// removed here and everything else must still equal the golden. Flag off / kill switch: this normaliser is never applied (strict).
//  - D1: the customer pay pages show a language switch link: <a class="exit" href="...lang=ar" hreflang="ar" lang="ar" dir="rtl" rel="nofollow">...</a>
//  - B1: the import wizard mapping response lists one more optional field (key 'language', type 'language') and the import result carries a 'localization' summary object.
const SWITCH_LINK_RE = /<a class="exit" href="[^"]*lang=ar" hreflang="ar" lang="ar" dir="rtl" rel="nofollow">[^<]{1,12}<\/a>/g;
const IMPORT_SUMMARY_KEYS = ['languagesFailed', 'languagesProtected', 'languagesSet', 'languagesSkipped', 'languagesUnchanged', 'translationsFailed', 'translationsSaved', 'translationsUnchanged'];
function stripFlaggedHttpAdditions(http) {
  const out = JSON.parse(JSON.stringify(http === undefined ? null : http));
  const walk = (node) => {
    if (typeof node === 'string') return node.replace(SWITCH_LINK_RE, '');
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) node[k] = walk(node[k]);
      if (Array.isArray(node.fields)) node.fields = node.fields.filter((f) => !(f && f.key === 'language' && f.type === 'language'));
      if (node.localization && typeof node.localization === 'object' && Object.keys(node.localization).every((k) => IMPORT_SUMMARY_KEYS.includes(k))) delete node.localization;
      return node;
    }
    return node;
  };
  return walk(out);
}

function strictEqual(g, a) {
  expect(a.calls).toEqual(g.calls);
  expect(a.db).toEqual(g.db);
  expect(a.returns).toEqual(g.returns);
  if (FLAG_ON && !KILL) expect(stripFlaggedHttpAdditions(a.http)).toEqual(g.http === undefined ? null : g.http);
  else expect(a.http).toEqual(g.http);
  if (STRICT_LOGS) expect(a.logs).toEqual(g.logs);
}

// ── APPROVED differences (the ONLY ones the wiring phase may introduce) ─────────────
// Keyed by scenario via opts.approve ('H1' | 'C3' | 'B2' | 'B4') - never a blanket allowance. H1/C3/B2 are global; B4 only
// applies to flagged workspaces, i.e. only in the ENG_FLAG=on mode.
const normPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); return d; };
const sortedJson = (obj) => Object.values(obj || {}).map((d) => JSON.stringify(d)).sort();

function approvalFor(name, opts) {
  if (opts.approve === 'H1') return approveH1;
  if (opts.approve === 'C3') return approveC3;
  if (opts.approve === 'B2') return approveB2;
  if (opts.approve === 'B4') return approveB4;
  if (opts.approve === 'B4J') return approveB4J;
  return null;
}

// H1: a STOP / opt-out opts out EVERY customer record of the workspace with the same normalised phone.
// Allowed in the MODIFIED run (in addition to exact baseline behaviour): extra Customer records of that phone
// carrying optedOut:true + optedOutAt, and one extra ConsentEvent per such record (consent_withdrawn, same method
// as the baseline event). Outbound calls, returns, http and every other collection must stay identical.
function approveH1(g, a) {
  expect(a.calls).toEqual(g.calls);
  expect(a.returns).toEqual(g.returns);
  expect(a.http).toEqual(g.http);
  const phones = ((a.meta && a.meta.senderPhones) || []).map(normPhone);
  const dbG = clone(g.db); const dbA = clone(a.db);
  for (const [label, doc] of Object.entries(dbA.customers || {})) {
    const gd = (dbG.customers || {})[label];
    if (gd && JSON.stringify(gd) !== JSON.stringify(doc) && phones.includes(normPhone(doc.phone)) && doc.optedOut === true) {
      const d2 = { ...doc };
      for (const k of ['optedOut', 'optedOutAt']) { if (gd[k] === undefined) delete d2[k]; else d2[k] = gd[k]; }
      dbA.customers[label] = d2;
    }
  }
  const gEv = sortedJson(dbG.consentevents); const aEv = sortedJson(dbA.consentevents);
  const rest = [...aEv];
  for (const s of gEv) { const i = rest.indexOf(s); expect(i).toBeGreaterThanOrEqual(0); rest.splice(i, 1); }
  const newlyOptedOut = Object.entries(a.db.customers || {}).filter(([label, doc]) => doc.optedOut === true && !(((g.db.customers || {})[label] || {}).optedOut === true)).length;
  expect(rest.length).toBeLessThanOrEqual(newlyOptedOut);
  for (const s of rest) {
    const d = JSON.parse(s);
    expect(d.type).toBe('consent_withdrawn');
    expect(['whatsapp_stop_command', 'whatsapp_optout_button']).toContain(d.method);
    expect(phones).toContain(normPhone(d.phone));
  }
  dbA.consentevents = dbG.consentevents; if (dbG.consentevents === undefined) delete dbA.consentevents;
  expect(dbA).toEqual(dbG);
}

// C3: the Meta error code is stored on a failed status callback. Allowed: extra error-code-like key(s) on
// CampaignMessage / WhatsAppMessage documents whose value is a Meta error code used by these scenarios.
// (Field name fixed by the D3 design: CampaignMessage.errorCode, a String.)
const ALLOWED_C3_KEY = /^errorCode$/; // D3 hunk S7: update.errorCode = String(s.errors[0].code).slice(0, 20) on CampaignMessage only
const C3_CODES = [131047, 131049, 132001, 131026, 131000, 131053];
function approveC3(g, a) {
  expect(a.calls).toEqual(g.calls);
  expect(a.returns).toEqual(g.returns);
  expect(a.http).toEqual(g.http);
  const dbA = clone(a.db);
  for (const coll of ['campaignmessages']) { // WhatsAppMessage is NOT part of the approved change (the webhook never reaches it for non-campaign wamids)
    for (const [label, doc] of Object.entries(dbA[coll] || {})) {
      const gd = (g.db[coll] || {})[label] || {};
      for (const k of Object.keys(doc)) {
        if (k in gd || !ALLOWED_C3_KEY.test(k)) continue;
        const vals = Array.isArray(doc[k]) ? doc[k] : [doc[k]];
        for (const v of vals) { expect(typeof v).toBe('string'); expect(C3_CODES).toContain(Number(v)); }
        expect(typeof doc.statusReason).toBe('string'); // written together with the failed callback's statusReason; a late failure keeps the row's status (the final equality below pins every other field)
        delete doc[k];
      }
    }
  }
  expect(dbA).toEqual(g.db);
}

// B2: Arabic-Indic digits / mis-decoded Arabic CSV are accepted where the old code failed. The scenario's own
// import result may differ; no outbound call may appear and nothing outside the import data may change.
function approveB2(g, a) {
  expect(a.calls).toEqual(g.calls);
  const allowed = new Set(['importjobs', 'customers', 'consentevents', 'pointsledgerentries']);
  const keys = new Set([...Object.keys(g.db), ...Object.keys(a.db)]);
  for (const k of keys) if (!allowed.has(k)) expect(a.db[k]).toEqual(g.db[k]);
}

// B4 (flagged workspaces ONLY): a one-word / absent WhatsApp profile name no longer blocks creating the customer. Allowed only
// when the arabic flag is on (and the kill switch is not): outbound calls must still be identical, the scenario's own db rows,
// returns and http results may differ (the customer now exists). Flag off / kill switch: strictly identical to baseline.
function approveB4(g, a) {
  if (FLAG_ON && !KILL) { expect(a.calls).toEqual(g.calls); return; }
  strictEqual(g, a);
}

// B4J: same B4 rule, for scenarios where the missing customer record was the ONLY reason for the English "couldn't find your profile"
// replies. Flagged workspace (flag on, no kill switch): the customer now exists, so everything downstream may differ (not asserted).
// Flag off / kill switch: strictly identical to baseline (calls, db, returns, http).
function approveB4J(g, a) {
  if (FLAG_ON && !KILL) return;
  strictEqual(g, a);
}

// ── lifecycle helpers used by the test file ──────────────────────────────────
function silenceConsole() {
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const fmt = (args) => args.map((x) => (x && x.message ? x.message : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
  console.log = () => {};
  console.info = () => {};
  console.warn = (...a) => { H.logs.warn.push(fmt(a)); };
  console.error = (...a) => { H.logs.error.push(fmt(a)); };
  if (process.env.ENG_VERBOSE === '1') { console.warn = (...a) => { H.logs.warn.push(fmt(a)); keep.warn(...a); }; console.error = (...a) => { H.logs.error.push(fmt(a)); keep.error(...a); }; }
  return () => { Object.assign(console, keep); };
}

function writeGolden() {
  if (RECORD) fs.writeFileSync(GOLDEN_FILE, JSON.stringify(H.results, null, 1));
}

module.exports = {
  approvals: { approveH1, approveC3, approveB2, approveB4, approveB4J, strictEqual },
  H, RECORD, FLAG_ON, KILL, GOLDEN_FILE, NEW_COLLECTION_RE, sleep,
  installAdapter, isMessage, isMsgType, isMsgTo,
  envelope, textMsg, tplBtn, ibtn, lrow, statusPayload, msgBase,
  rawSnapshot, scenario, quiet, settle, silenceConsole, writeGolden,
};
