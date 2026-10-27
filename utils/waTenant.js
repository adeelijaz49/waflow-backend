'use strict';
// Which WhatsApp number (phone id + WABA + access token) does a given customer (workspace) send from?
//
//   platformSender()          the WaFlow platform number: WA_PHONE_ID / tokenManager token / WA_WABA_ID (what every send used before)
//   resolveSender(wsId)       that workspace's sender, 60 s memo; a workspace without a number gets the platform sender
//   resolveCurrent()          the sender for the work in progress (utils/senderContext.js: the logged-in workspace, the webhook
//                             event's workspace, a flow sweep...), or the platform sender when forced / no context
//   invalidate(wsId?)         forget the memo (call after the number or token of a workspace changes)
//   WhatsAppNumberUnavailable thrown when a workspace HAS its own number that cannot be used
//
// FAIL CLOSED: a workspace that has configured its own number never silently sends from the platform number. If its token
// cannot be decrypted, is flagged invalid, or the number sits in a WABA the platform token cannot serve, resolveSender THROWS.
// The platform number is only used when the workspace has no number configured (or has switched it off with enabled:false).
//
// The token is never logged and never returned by anything except the sender object handed to utils/whatsapp.js; the
// decrypted value lives only in this module's 60 s memo.
const axios = require('axios');
const tokenManager = require('./tokenManager');
const senderContext = require('./senderContext');

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const MEMO_MS = 60 * 1000;
const STALE_OK_MS = 10 * 60 * 1000; // a lookup that FAILS may be answered from an entry that expired less than this long ago ...
const STALE_RETRY_MS = 5 * 1000;    // ... and is tried again after this long
const DEFAULT_PLATFORM_PHONE_ID = '1032683093271618';

class WhatsAppNumberUnavailable extends Error {
  constructor(reason, workspaceId) {
    super('This WhatsApp number cannot be used right now. Please ask your WaFlow administrator to check the WhatsApp connection.');
    this.name = 'WhatsAppNumberUnavailable';
    this.code = 'WHATSAPP_NUMBER_UNAVAILABLE';
    this.status = 409;
    this.reason = reason || 'unavailable'; // short machine reason, never contains a secret
    if (workspaceId) this.workspaceId = String(workspaceId);
  }
}

// ── platform identity ───────────────────────────────────────────────────────────

let cachedPlatformWaba = null;

function platformPhoneId() {
  return process.env.WA_PHONE_ID || DEFAULT_PLATFORM_PHONE_ID;
}

/** The platform WABA id when it is already known without any network call (env or an earlier discovery), else null. */
function platformWabaIdSync() {
  return cachedPlatformWaba || process.env.WA_WABA_ID || null;
}

/**
 * The platform WABA id: cached value, WA_WABA_ID, else discovered through Graph with the PLATFORM token (same two lookups, in
 * the same order, as utils/whatsapp.js did before this module existed). Throws the original descriptive Error when it cannot
 * be found.
 */
async function getPlatformWabaId() {
  if (cachedPlatformWaba) return cachedPlatformWaba;

  // Approach 1: explicit env var (most reliable - set once)
  if (process.env.WA_WABA_ID) {
    cachedPlatformWaba = process.env.WA_WABA_ID;
    return cachedPlatformWaba;
  }

  // Approach 2: list WABAs accessible to this token (works with messaging scope)
  try {
    const res = await axios.get(`${GRAPH_BASE}/me/whatsapp_business_accounts`, {
      params: { access_token: tokenManager.getToken() },
    });
    const id = res.data?.data?.[0]?.id;
    if (id) { cachedPlatformWaba = id; return cachedPlatformWaba; }
  } catch (_) {}

  // Approach 3: query phone number ID for its WABA (requires business_management scope)
  try {
    const res = await axios.get(`${GRAPH_BASE}/${platformPhoneId()}`, {
      params: { fields: 'whatsapp_business_account', access_token: tokenManager.getToken() },
    });
    const id = res.data?.whatsapp_business_account?.id;
    if (id) { cachedPlatformWaba = id; return cachedPlatformWaba; }
  } catch (_) {}

  throw new Error(
    'Cannot detect WABA ID automatically. ' +
    'Add WA_WABA_ID to your environment variables. ' +
    'Find it in: Meta Developer Portal → Your App → WhatsApp → API Setup → WhatsApp Business Account ID.'
  );
}

/** Synchronous platform sender. wabaId is whatever is known without a network call (see platformWabaIdSync). */
function platformSender() {
  return {
    source: 'platform',
    workspaceId: null,
    phoneId: platformPhoneId(),
    wabaId: platformWabaIdSync(),
    token: tokenManager.getToken(),
    displayNumber: null,
    sharesPlatformWaba: true,
    ownToken: false, // true = a token saved for this customer (not the platform token)
  };
}

// ── per-workspace resolution ────────────────────────────────────────────────────

// workspaceId -> { exp, confirmedUntil, entry }. exp = when it is read again; confirmedUntil = when it was last confirmed true, plus the memo
// time (moves only on a real read: it is what the "stale if the database fails" window counts from).
// entry = { platform:true } | { phoneId, wabaId, token|null, usePlatformToken, displayNumber, sharesPlatformWaba }
const memo = new Map();
// workspaceId -> how many times invalidate() ran for it. A read that STARTED before an invalidate() may hold data from before the change
// (the number or the token was just changed): its answer must not be stored in the memo, nor stand in for a read that failed.
const generations = new Map();
let allGenerations = 0; // raised by invalidate() with no argument
const generationOf = (id) => `${allGenerations}:${generations.get(id) || 0}`;
// `${workspaceId}|${phoneId}` -> WABA id discovered for a tenant that has its own token but no stored wabaId
const discoveredWaba = new Map();

function isObjectIdString(s) { return /^[0-9a-fA-F]{24}$/.test(s); }

async function loadWorkspaceNumber(workspaceId) {
  const Workspace = require('../models/Workspace');
  return Workspace.findById(workspaceId).select('+whatsapp.tokenEncrypted').lean();
}

async function buildEntry(workspaceId) {
  let ws;
  try {
    ws = await loadWorkspaceNumber(workspaceId);
  } catch (err) {
    // Cannot tell whether this workspace has its own number: refuse rather than guess the platform one.
    throw new WhatsAppNumberUnavailable('lookup_failed', workspaceId);
  }
  const w = (ws && ws.whatsapp) || {};
  const phoneId = typeof w.phoneId === 'string' ? w.phoneId.trim() : '';
  if (!ws || !phoneId || w.enabled === false) return { platform: true };

  const wabaId = typeof w.wabaId === 'string' && w.wabaId.trim() ? w.wabaId.trim() : null;
  const displayNumber = w.displayPhoneNumber || null;

  if (w.tokenEncrypted) {
    if (w.tokenIsValid === false) throw new WhatsAppNumberUnavailable('token_invalid', workspaceId);
    let token;
    try {
      token = require('../shared/onboarding/tokenVault').decrypt(w.tokenEncrypted, { workspaceId: String(workspaceId), purpose: 'token' });
    } catch (_) {
      throw new WhatsAppNumberUnavailable('token_unreadable', workspaceId); // wrong key, tampered, moved, key not configured
    }
    if (!token) throw new WhatsAppNumberUnavailable('token_unreadable', workspaceId);
    // Its own token: it may still sit in the platform WABA only when it says so explicitly.
    const sharesPlatformWaba = !!wabaId && !!platformWabaIdSync() && wabaId === platformWabaIdSync();
    return { phoneId, wabaId, token, usePlatformToken: false, displayNumber, sharesPlatformWaba };
  }

  // No token of its own: only a number added INSIDE the platform WABA can ride on the platform token.
  if (wabaId) {
    let platformWaba = platformWabaIdSync();
    if (!platformWaba) { try { platformWaba = await getPlatformWabaId(); } catch (_) { platformWaba = null; } }
    if (!platformWaba || platformWaba !== wabaId) throw new WhatsAppNumberUnavailable('no_token', workspaceId);
  }
  return { phoneId, wabaId, token: null, usePlatformToken: true, displayNumber, sharesPlatformWaba: true };
}

function senderFromEntry(workspaceId, entry) {
  if (entry.platform) return null;
  return {
    source: 'tenant',
    workspaceId: String(workspaceId),
    phoneId: entry.phoneId,
    wabaId: entry.wabaId,
    token: entry.usePlatformToken ? tokenManager.getToken() : entry.token, // the platform token can be refreshed: never frozen in the memo
    displayNumber: entry.displayNumber,
    ownToken: !entry.usePlatformToken,
    sharesPlatformWaba: !!(entry.sharesPlatformWaba || (entry.wabaId && entry.wabaId === platformWabaIdSync())),
  };
}

async function withWaba(sender) {
  if (sender.wabaId) return sender;
  try {
    return { ...sender, wabaId: await wabaIdOf(sender) };
  } catch (_) {
    return sender; // still null: callers that need it call wabaIdOf and get the descriptive error
  }
}

/**
 * The sender (phone id, WABA, token) a workspace sends from.
 * @param {*} workspaceId
 * @param {{waba?: boolean}} [opts] waba:false skips the WABA lookup (a possible Graph call) - the send path never needs it
 * @throws {WhatsAppNumberUnavailable} the workspace has its own number and it cannot be used
 */
async function resolveSender(workspaceId, opts = {}) {
  const needWaba = opts.waba !== false;
  const id = workspaceId ? String(workspaceId) : '';
  if (!id || !isObjectIdString(id)) return needWaba ? withWaba(platformSender()) : platformSender();
  const asPlatform = () => { const p = { ...platformSender(), workspaceId: id }; return needWaba ? withWaba(p) : p; };

  let hit = memo.get(id);
  if (!hit || hit.exp <= Date.now()) {
    const generation = generationOf(id);
    const expired = hit; // what the memo held (expired) when this read began
    try {
      const entry = await buildEntry(id); // throws are NOT memoised: the next call tries again
      const confirmedUntil = Date.now() + MEMO_MS;
      hit = { exp: confirmedUntil, confirmedUntil, entry };
      // invalidate() ran while this was being read: the answer may be from before the change, so it serves THIS call only
      if (generationOf(id) === generation) memo.set(id, hit);
    } catch (err) {
      // The database could not be asked (not: the number is unusable).
      const now = Date.now();
      const current = memo.get(id);
      if (current && current !== expired && current.exp > now) {
        hit = current; // a request that began later has read it successfully since: that answer is used, and left as it is
      } else if (err && err.reason === 'lookup_failed' && expired && current === expired && generationOf(id) === generation && now - expired.confirmedUntil < STALE_OK_MS) {
        // For a few minutes the entry that expired a moment ago is still the best knowledge there is, and better than every send of this
        // customer stopping while one read keeps failing. An entry that was never read, or was dropped by invalidate() (the number or token
        // was just changed - also while this read was under way), is not there to fall back on: fail closed.
        console.warn(`[waTenant] the WhatsApp number of workspace ${id} could not be re-read (database): using what was known ${Math.round((now - expired.confirmedUntil) / 1000)} s ago`);
        hit = { exp: now + STALE_RETRY_MS, confirmedUntil: expired.confirmedUntil, entry: expired.entry };
        memo.set(id, hit);
      } else {
        throw err;
      }
    }
  }
  const sender = senderFromEntry(id, hit.entry);
  if (!sender) return asPlatform();
  return needWaba ? withWaba(sender) : sender;
}

/**
 * The sender for the work in progress (see utils/senderContext.js). Platform when forced or when there is no context. Work that
 * arrived on the SHARED number (a webhook event) is answered from the shared number even when its workspace has a number of its
 * own by now: the customer's 24-hour window is with the number they wrote to.
 */
async function resolveCurrent(opts = {}) {
  const needWaba = opts.waba !== false;
  if (senderContext.isPlatformForced()) return needWaba ? withWaba(platformSender()) : platformSender();
  const workspaceId = senderContext.currentWorkspaceId();
  if (!workspaceId) return needWaba ? withWaba(platformSender()) : platformSender();
  if (senderContext.isViaPlatformNumber()) {
    const shared = { ...platformSender(), workspaceId };
    return needWaba ? withWaba(shared) : shared;
  }
  return resolveSender(workspaceId, opts);
}

/**
 * The WABA id of a sender. Platform / platform-WABA senders: the platform WABA (discovered once). A tenant with its own token
 * and no stored wabaId: looked up from its phone number with ITS token (cached per workspace+number).
 */
async function wabaIdOf(sender) {
  if (sender.wabaId) return sender.wabaId;
  if (sender.source === 'platform' || sender.sharesPlatformWaba) return getPlatformWabaId();
  const key = `${sender.workspaceId}|${sender.phoneId}`;
  if (discoveredWaba.has(key)) return discoveredWaba.get(key);
  const res = await axios.get(`${GRAPH_BASE}/${sender.phoneId}`, {
    params: { fields: 'whatsapp_business_account' },
    headers: { Authorization: `Bearer ${sender.token}` },
  });
  const id = res.data?.whatsapp_business_account?.id;
  if (!id) throw new Error('Cannot detect the WhatsApp Business Account of this number. Ask your WaFlow administrator to enter the WABA id.');
  discoveredWaba.set(key, id);
  return id;
}

/** Forget the memo for one workspace (or all). Call after the number / token of a workspace changes. */
function invalidate(workspaceId) {
  if (workspaceId === undefined || workspaceId === null) { memo.clear(); discoveredWaba.clear(); allGenerations += 1; return; }
  const id = String(workspaceId);
  memo.delete(id);
  generations.set(id, (generations.get(id) || 0) + 1);
  for (const k of [...discoveredWaba.keys()]) if (k.startsWith(`${id}|`)) discoveredWaba.delete(k);
}

/** Run fn on the platform number whatever the surrounding context says (OTP login, team invites). */
function runPlatform(fn) {
  return senderContext.runPlatform(fn);
}

// test seams
function _resetForTests() { memo.clear(); discoveredWaba.clear(); generations.clear(); cachedPlatformWaba = null; }

module.exports = {
  platformSender,
  resolveSender,
  resolveCurrent,
  invalidate,
  runPlatform,
  getPlatformWabaId,
  wabaIdOf,
  WhatsAppNumberUnavailable,
  GRAPH_BASE,
  _resetForTests,
};
