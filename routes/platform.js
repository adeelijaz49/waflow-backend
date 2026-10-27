'use strict';
// /api/platform - the WaFlow super-admin console API: customers (tenants), their owners, their own WhatsApp number, and
// "enter this customer" sessions. Mounted by server.js as
//   app.use('/api/platform', requireAuth, requireSuperAdmin, require('./routes/platform'));
// and, defensively, this router checks both again (a no-op when the mount already did), so a wrong mount can never expose it.
//
// Rules that hold for every route here:
//   * Only people on the SUPER_ADMIN_CONTACTS allowlist get in (middleware/requireSuperAdmin.js re-checks the database on
//     every request). A session that "entered" a customer (actAs) is refused everywhere except POST /exit.
//   * Every write appends a PlatformAuditLog row BEFORE it mutates ("log-before-mutate"): if the log cannot be written the
//     change is not made. No row, and no response, ever carries a secret (tokens, full contacts).
//   * A customer's own WhatsApp access token is stored ONLY through shared/onboarding/tokenVault (AES-GCM, bound to the
//     workspace) and is never returned: the API says "tokenConfigured: true", nothing more.
//   * Nothing here deletes a document.
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Service = require('../models/Service');
const Promotion = require('../models/Promotion');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const LocaleSettings = require('../models/LocaleSettings');
const PlatformAuditLog = require('../models/PlatformAuditLog');
const tokenVault = require('../shared/onboarding/tokenVault');
const platformAdmin = require('../shared/platformAdmin');
const { requireAuth, JWT_SECRET, ISSUER, AUDIENCE } = require('../middleware/requireAuth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const ENTER_TTL = '8h';
const LIST_LIMIT = 200;
const PLATFORM_PHONE_ID_DEFAULT = '1032683093271618'; // utils/whatsapp.js's own default for WA_PHONE_ID

// ── small helpers ────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const isId = (value) => typeof value === 'string' && OBJECT_ID_RE.test(value);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Plain text typed by staff: trimmed, no control / zero-width / bidi-override characters, bounded.
// eslint-disable-next-line no-control-regex
const HIDDEN_RE = /[\x00-\x1f\x7f-\x9f\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu;
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(HIDDEN_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!text || Array.from(text).length > max) return null;
  return text;
}

function digitsOrNull(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  return new RegExp(`^\\d{${min},${max}}$`).test(text) ? text : undefined; // undefined = present but invalid
}

const last4 = (value) => (value ? String(value).slice(-4) : null);

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
      if (err && err.code === 'ENCRYPTION_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'Saving a WhatsApp token is not set up on this server yet (WA_TOKEN_ENCRYPTION_KEY).', code: 'ENCRYPTION_NOT_CONFIGURED' });
      }
      console.error('[platform] unexpected error:', err && err.message); // message only: nothing from the request body
      return res.status(500).json({ error: 'Something went wrong. Nothing was lost; please try again.' });
    }
  };
}

// Defaults for the injectable dependencies (tests pass their own, so no test ever uses the network).
//
// metaCheck({ phoneId, wabaId, token }) -> { phoneOk, tokenIsValid, displayPhoneNumber, verifiedName, wabaId, error?, transient? }
//   `token` undefined = "use the platform token". READ-ONLY Graph calls: GET /{phoneId}?fields=... and, when the app
//   credentials are configured and a token is being tested, GET /debug_token. Throws when Graph cannot be reached; answers
//   transient: true when Graph answered but only to say "busy / try later" (5xx, 429, a throttling error code): that says nothing
//   about the number or the token, so runCheck turns it into "could not check" and nothing is saved or marked invalid.
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80007]); // unknown error, temporary service error, call/rate limits
function isTransientGraphFailure(status, error) {
  if (status >= 500 || status === 429 || status === 408) return true;
  return !!error && (error.is_transient === true || TRANSIENT_GRAPH_CODES.has(Number(error.code)));
}
async function defaultMetaCheck({ phoneId, token }) {
  const axios = require('axios');
  const metaConfig = require('../shared/onboarding/metaConfig');
  const { sanitizeMessage } = require('../shared/onboarding/metaClient');
  const secret = token || require('../utils/tokenManager').getToken();
  if (!secret) return { phoneOk: false, tokenIsValid: null, error: 'No access token is available to check this number.' };
  const base = metaConfig.GRAPH_BASE();
  const opts = { headers: { Authorization: `Bearer ${secret}` }, timeout: 10000, validateStatus: () => true };

  let res = await axios.get(`${base}/${phoneId}`, { ...opts, params: { fields: 'display_phone_number,verified_name,whatsapp_business_account' } });
  if (res.status === 400 && res.data && res.data.error && res.data.error.code === 100) {
    // an older/newer Graph version may not offer the account field on this node: ask for the core fields only
    res = await axios.get(`${base}/${phoneId}`, { ...opts, params: { fields: 'display_phone_number,verified_name' } });
  }
  const out = { phoneOk: false, tokenIsValid: null, displayPhoneNumber: null, verifiedName: null, wabaId: null };
  if (res.status >= 200 && res.status < 300 && res.data && typeof res.data === 'object') {
    out.phoneOk = true;
    out.displayPhoneNumber = res.data.display_phone_number || null;
    out.verifiedName = res.data.verified_name || null;
    out.wabaId = res.data.whatsapp_business_account && res.data.whatsapp_business_account.id ? String(res.data.whatsapp_business_account.id) : null;
  } else {
    const e = res.data && res.data.error;
    out.error = sanitizeMessage((e && e.message) || `HTTP ${res.status}`, [secret]);
    if (e && e.code === 190) out.tokenIsValid = false; // OAuthException: the token itself is bad
    else if (isTransientGraphFailure(res.status, e)) out.transient = true;
  }

  if (token && process.env.WA_APP_ID && process.env.WA_APP_SECRET) {
    try {
      const dbg = await axios.get('https://graph.facebook.com/debug_token', {
        params: { input_token: token, access_token: `${process.env.WA_APP_ID}|${process.env.WA_APP_SECRET}` },
        timeout: 10000, validateStatus: () => true,
      });
      const info = dbg.data && dbg.data.data;
      if (info && typeof info.is_valid === 'boolean') out.tokenIsValid = info.is_valid;
    } catch (_) { /* debug_token is a bonus check: the phone-number call above already proved or disproved access */ }
  }
  return out;
}

// A number or token was just saved, verified or cleared: forget what the sender and the webhook router learned about it, so the new
// state applies at once (otherwise a new number is only recognised after the short negative cache, a cleared one after the memo).
function defaultInvalidateSender(workspaceId) {
  try {
    const waTenant = require('../utils/waTenant'); // owned by the sender work; tolerate its absence
    if (waTenant && typeof waTenant.invalidate === 'function') waTenant.invalidate(String(workspaceId));
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') console.error('[platform] could not clear the sender cache:', err && err.message);
  }
  try {
    const inbound = require('../shared/whatsappInbound');
    if (inbound && typeof inbound.invalidatePhoneId === 'function') inbound.invalidatePhoneId();
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') console.error('[platform] could not clear the webhook routing cache:', err && err.message);
  }
}

// ── data shaping ─────────────────────────────────────────────────────────────

function whatsappStatus(ws) {
  const w = (ws && ws.whatsapp) || {};
  return {
    mode: w.phoneId ? 'own' : 'platform',
    phoneIdLast4: last4(w.phoneId),
    wabaId: w.wabaId || null,
    displayPhoneNumber: w.displayPhoneNumber || null,
    verifiedName: w.verifiedName || null,
    tokenConfigured: !!w.tokenEncrypted,
    tokenIsValid: typeof w.tokenIsValid === 'boolean' ? w.tokenIsValid : null,
    checkedAt: w.tokenCheckedAt || null,
    enabled: w.enabled !== false,
  };
}

const contactOf = (user) => (user ? (user.phone || user.email || '') : '');
const memberOf = (membership, user) => ({
  userId: String(membership.userId),
  name: (user && user.name) || '',
  contactMasked: platformAdmin.maskContact(contactOf(user)),
  role: membership.role,
  createdAt: membership.createdAt,
});

const WS_SELECT = '+whatsapp.tokenEncrypted'; // select:false in the model: only its PRESENCE is read, never returned

async function loadWorkspace(id) {
  if (!isId(String(id))) throw new HttpError(404, 'Customer not found');
  const ws = await Workspace.findById(id).select(WS_SELECT).lean();
  if (!ws) throw new HttpError(404, 'Customer not found');
  return ws;
}

// Tenant rows for a page of workspaces, with batched queries (no per-row round trips).
async function buildTenants(workspaces) {
  if (!workspaces.length) return [];
  const ids = workspaces.map((w) => w._id);
  const [memberships, customerCounts, subs, locales, oldest] = await Promise.all([
    Membership.find({ workspaceId: { $in: ids } }).select('userId workspaceId role createdAt').lean(),
    Customer.aggregate([{ $match: { workspaceId: { $in: ids }, deletedAt: null } }, { $group: { _id: '$workspaceId', n: { $sum: 1 } } }]),
    Subscription.find({ workspaceId: { $in: ids } }).select('workspaceId planId status').lean(),
    LocaleSettings.find({ workspaceId: { $in: ids } }).select('workspaceId arabicEnabled').lean(),
    Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean(), // the platform default = the OLDEST workspace (as server.js picks it)
  ]);
  const ownerIds = [...new Set(memberships.filter((m) => m.role === 'owner').map((m) => String(m.userId)))];
  const [users, plans] = await Promise.all([
    ownerIds.length ? User.find({ _id: { $in: ownerIds } }).select('name phone email').lean() : [],
    subs.length ? Plan.find({ _id: { $in: subs.map((s) => s.planId) } }).select('code').lean() : [],
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const planById = new Map(plans.map((p) => [String(p._id), p.code]));
  const customersBy = new Map(customerCounts.map((c) => [String(c._id), c.n]));
  const subBy = new Map(subs.map((s) => [String(s.workspaceId), s]));
  const arabicBy = new Map(locales.map((l) => [String(l.workspaceId), !!l.arabicEnabled]));
  const oldestId = oldest ? String(oldest._id) : null;

  return workspaces.map((ws) => {
    const key = String(ws._id);
    const mine = memberships.filter((m) => String(m.workspaceId) === key);
    const sub = subBy.get(key);
    return {
      id: key,
      name: ws.name,
      createdAt: ws.createdAt,
      isPlatformDefault: key === oldestId,
      owners: mine.filter((m) => m.role === 'owner').map((m) => {
        const u = userById.get(String(m.userId));
        return { userId: String(m.userId), name: (u && u.name) || '', contactMasked: platformAdmin.maskContact(contactOf(u)) };
      }),
      memberCount: mine.length,
      customerCount: customersBy.get(key) || 0,
      plan: sub ? { code: planById.get(String(sub.planId)) || null, status: sub.status } : null,
      arabicEnabled: arabicBy.get(key) || false,
      whatsapp: whatsappStatus(ws),
    };
  });
}

async function buildTenant(ws) {
  return (await buildTenants([ws]))[0];
}

// ── audit ────────────────────────────────────────────────────────────────────

// Appended BEFORE the change it describes. If this throws, the handler stops and nothing is mutated.
async function audit(req, action, workspaceId, detail) {
  try {
    await PlatformAuditLog.create({
      actorUserId: req.user.id,
      actorLabel: platformAdmin.maskUser(req.platformActor),
      action,
      workspaceId,
      ip: req.ip,
      forwardedFor: String(req.get('x-forwarded-for') || '').slice(0, 200),
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
      detail: detail || {},
    });
  } catch (err) {
    console.error('[platform] audit write failed, change refused:', err && err.message);
    throw new HttpError(500, 'Could not record this action in the audit log, so nothing was changed. Please try again.');
  }
}

// ── users ────────────────────────────────────────────────────────────────────

const contactQuery = (c) => (c.type === 'phone' ? { phone: c.contact } : { email: c.contact });

async function createUserForContact(contact, name) {
  const query = contactQuery(contact);
  try {
    const user = await User.create({ ...query, ...(name ? { name } : {}) });
    return { user, created: true };
  } catch (err) {
    if (err && err.code === 11000) { // a concurrent request created the same person first
      const user = await User.findOne(query);
      if (user) return { user, created: false };
    }
    throw err;
  }
}

async function nameUserIfBlank(user, name) {
  if (!name || (user.name && String(user.name).trim())) return;
  await User.updateOne({ _id: user._id, $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] }, { $set: { name } });
}

function readContact(type, raw, label) {
  const contact = platformAdmin.normalizeContact(type, raw);
  if (!contact) {
    throw new HttpError(400, type === 'email'
      ? `${label} is not a valid email address.`
      : `${label} is not a valid phone number. Use the full number with its country code, digits only (for example 9665XXXXXXXX).`);
  }
  return contact;
}

// ── the router ───────────────────────────────────────────────────────────────

function createRouter(overrides = {}) {
  const router = express.Router();
  const deps = { metaCheck: defaultMetaCheck, invalidateSender: defaultInvalidateSender, ...overrides };
  router.deps = deps; // tests (and only tests) can swap a dependency after creation

  router.use((req, res, next) => (req.user ? next() : requireAuth(req, res, next)), requireSuperAdmin);

  // ── customers (tenants) ────────────────────────────────────────────────────

  router.get('/tenants', wrap(async (req, res) => {
    const filter = {};
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    if (search) filter.name = new RegExp(escapeRegex(search), 'i');
    // Newest first by _id (creation order; always indexed - Cosmos DB for MongoDB rejects a {createdAt, _id} sort no compound index serves).
    const workspaces = await Workspace.find(filter).select(WS_SELECT).sort({ _id: -1 }).limit(LIST_LIMIT).lean();
    res.json({ tenants: await buildTenants(workspaces) });
  }));

  router.post('/tenants', wrap(async (req, res) => {
    const body = bodyOf(req);
    const name = cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Enter the customer name (up to 100 characters).');
    if (body.ownerContactType !== 'phone' && body.ownerContactType !== 'email') {
      throw new HttpError(400, 'Choose whether the owner signs in with a phone number or an email.');
    }
    const contact = readContact(body.ownerContactType, body.ownerContact, 'The owner contact');
    let ownerName = null;
    if (body.ownerName !== undefined && body.ownerName !== null && body.ownerName !== '') {
      ownerName = cleanText(body.ownerName, 100);
      if (!ownerName) throw new HttpError(400, 'The owner name is too long or empty.');
    }
    let currency = null;
    if (body.currency !== undefined && body.currency !== null && body.currency !== '') {
      if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency.trim())) {
        throw new HttpError(400, 'The currency must be a 3-letter code such as SAR.');
      }
      currency = body.currency.trim().toUpperCase();
    }
    let defaultCountryCode = null;
    if (body.defaultCountryCode !== undefined && body.defaultCountryCode !== null && body.defaultCountryCode !== '') {
      const code = String(body.defaultCountryCode).trim().replace(/^\+/, '');
      if (!/^\d{1,4}$/.test(code)) throw new HttpError(400, 'The default country code must be 1 to 4 digits, for example 966.');
      defaultCountryCode = code;
    }

    const existingUser = await User.findOne(contactQuery(contact));
    // A double-click or a retry must not make a second copy of the same customer for the same owner.
    if (existingUser) {
      const sameName = await Workspace.find({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }).select('_id').limit(50).lean();
      if (sameName.length) {
        const dup = await Membership.exists({ userId: existingUser._id, role: 'owner', workspaceId: { $in: sameName.map((w) => w._id) } });
        if (dup) throw new HttpError(409, 'A customer with this name and this owner already exists.', { code: 'TENANT_EXISTS' });
      }
    }

    const workspaceId = new mongoose.Types.ObjectId(); // known up front so the audit row can name it before anything is created
    await audit(req, 'create_tenant', workspaceId, {
      name, ownerContactType: contact.type, ownerContactMasked: platformAdmin.maskContact(contact.contact),
      ownerExisted: !!existingUser, currency, defaultCountryCode,
    });

    let steps = 'user';
    try {
      const resolved = existingUser ? { user: existingUser, created: false } : await createUserForContact(contact, ownerName);
      const { user, created } = resolved;
      if (!created) await nameUserIfBlank(user, ownerName);

      steps = 'workspace';
      // completed:true so the owner's first login skips the setup wizard (a pilot customer is set up by WaFlow staff)
      const workspace = await Workspace.create({ _id: workspaceId, name, onboarding: { completed: true, currentStep: 5 } });
      steps = 'membership';
      await Membership.create({ userId: user._id, workspaceId, role: 'owner' }); // so the owner's first login lands directly here (no Invite matching)
      steps = 'settings';
      const settings = { merchantName: name };
      if (currency) settings.currency = currency;
      if (defaultCountryCode) settings.defaultCountryCode = defaultCountryCode;
      await require('../shared/operations').updateLoyaltySettings(settings, { workspaceId });
      steps = 'subscription';
      await require('../shared/entitlements').getOrCreateSubscription(workspaceId);

      const others = await Membership.countDocuments({ userId: user._id, workspaceId: { $ne: workspaceId } });
      const how = contact.type === 'phone' ? 'the WhatsApp number' : 'the email address';
      const signInHint = `Tell the owner to open WaFlow and sign in with ${how} ${platformAdmin.maskContact(contact.contact)}. `
        + (others > 0 ? `They already use WaFlow, so they will be asked to choose between their workspaces and should pick "${name}".` : `They will land straight in "${name}".`)
        + ' No message has been sent to them.';
      const fresh = await Workspace.findById(workspace._id).select(WS_SELECT).lean();
      res.status(201).json({ tenant: await buildTenant(fresh), owner: { userId: String(user._id), created }, signInHint });
    } catch (err) {
      if (steps === 'user' || steps === 'workspace') throw err;
      console.error(`[platform] customer ${workspaceId} was created but the "${steps}" step failed:`, err && err.message);
      throw new HttpError(500, 'The customer was created but setting it up did not finish. Open it from the list and check it, or ask for help.', { workspaceId: String(workspaceId), failedStep: steps });
    }
  }));

  router.get('/tenants/:id', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    const [tenant, memberships, customers, products, services, promotions] = await Promise.all([
      buildTenant(ws),
      Membership.find({ workspaceId: ws._id }).sort({ _id: 1 }).select('userId role createdAt').lean(), // oldest first; _id is the one field Cosmos always has an index for
      Customer.countDocuments({ workspaceId: ws._id, deletedAt: null }),
      Product.countDocuments({ workspaceId: ws._id }),
      Service.countDocuments({ workspaceId: ws._id }),
      Promotion.countDocuments({ workspaceId: ws._id }),
    ]);
    const users = memberships.length ? await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select('name phone email').lean() : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      tenant,
      members: memberships.map((m) => memberOf(m, byId.get(String(m.userId)))),
      counts: { customers, products, services, promotions },
    });
  }));

  router.patch('/tenants/:id', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    const name = cleanText(bodyOf(req).name, 100);
    if (!name) throw new HttpError(400, 'Enter the customer name (up to 100 characters).');
    await audit(req, 'rename', ws._id, { from: ws.name, to: name });
    await Workspace.updateOne({ _id: ws._id }, { $set: { name } });
    const fresh = await Workspace.findById(ws._id).select(WS_SELECT).lean();
    res.json({ tenant: await buildTenant(fresh) });
  }));

  router.post('/tenants/:id/members', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    const body = bodyOf(req);
    if (body.contactType !== 'phone' && body.contactType !== 'email') throw new HttpError(400, 'Choose whether this person signs in with a phone number or an email.');
    const contact = readContact(body.contactType, body.contact, 'The contact');
    const role = body.role === undefined || body.role === null || body.role === '' ? 'member' : body.role;
    if (role !== 'owner' && role !== 'member') throw new HttpError(400, 'The role must be owner or member.');
    let name = null;
    if (body.name !== undefined && body.name !== null && body.name !== '') {
      name = cleanText(body.name, 100);
      if (!name) throw new HttpError(400, 'The name is too long or empty.');
    }

    const existingUser = await User.findOne(contactQuery(contact));
    const existingMembership = existingUser ? await Membership.findOne({ userId: existingUser._id, workspaceId: ws._id }).lean() : null;
    if (existingMembership && existingMembership.role === role) {
      return res.status(200).json({ member: memberOf(existingMembership, existingUser), created: false });
    }
    if (existingMembership && existingMembership.role === 'owner' && role === 'member') {
      throw new HttpError(409, 'This person is already an owner of this customer.');
    }

    await audit(req, 'add_member', ws._id, {
      contactType: contact.type, contactMasked: platformAdmin.maskContact(contact.contact), role,
      userExisted: !!existingUser, previousRole: existingMembership ? existingMembership.role : null,
    });
    const { user } = existingUser ? { user: existingUser } : await createUserForContact(contact, name);
    if (existingUser) await nameUserIfBlank(user, name);

    let membership;
    if (existingMembership) { // member -> owner
      await Membership.updateOne({ _id: existingMembership._id }, { $set: { role } });
      membership = await Membership.findById(existingMembership._id).lean();
    } else {
      try {
        membership = (await Membership.create({ userId: user._id, workspaceId: ws._id, role })).toObject();
      } catch (err) {
        if (err && err.code === 11000) { // a concurrent request added them first
          const again = await Membership.findOne({ userId: user._id, workspaceId: ws._id }).lean();
          return res.status(200).json({ member: memberOf(again, user), created: false });
        }
        throw err;
      }
    }
    const fresh = await User.findById(user._id).select('name phone email').lean();
    res.status(existingMembership ? 200 : 201).json({ member: memberOf(membership, fresh), created: !existingMembership });
  }));

  // ── a customer's own WhatsApp number ───────────────────────────────────────

  router.put('/tenants/:id/whatsapp', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    const body = bodyOf(req);

    const phoneId = digitsOrNull(body.phoneId, 5, 25);
    if (!phoneId) throw new HttpError(400, 'Enter the phone number id from Meta (digits only).');
    const wabaId = digitsOrNull(body.wabaId, 5, 25);
    if (wabaId === undefined) throw new HttpError(400, 'The WhatsApp business account id must be digits only.');
    let token = null;
    if (body.accessToken !== undefined && body.accessToken !== null && body.accessToken !== '') {
      token = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
      if (token.length < 10 || token.length > 2000 || /\s/.test(token)) throw new HttpError(400, 'That does not look like a WhatsApp access token. Paste the whole token with no spaces.');
    }
    const verify = body.verify !== false;

    if (phoneId === (process.env.WA_PHONE_ID || PLATFORM_PHONE_ID_DEFAULT)) {
      throw new HttpError(409, 'That is the WaFlow platform number. To use it, choose "Use platform number" instead.', { code: 'PLATFORM_NUMBER' });
    }
    const clash = await Workspace.findOne({ 'whatsapp.phoneId': phoneId, _id: { $ne: ws._id } }).select('name').lean();
    if (clash) throw new HttpError(409, `That phone number id is already used by another customer (${clash.name}).`, { code: 'PHONE_ID_IN_USE' });

    const stored = (ws.whatsapp && ws.whatsapp.tokenEncrypted) || null;
    const platformWaba = String(process.env.WA_WABA_ID || '').trim() || null;
    if (token) {
      if (!tokenVault.isConfigured()) throw new HttpError(503, 'Saving a WhatsApp token is not set up on this server yet (WA_TOKEN_ENCRYPTION_KEY).', { code: 'ENCRYPTION_NOT_CONFIGURED' });
    } else if (wabaId && wabaId !== platformWaba && !stored) {
      throw new HttpError(400, 'A number in its own WhatsApp business account needs its access token. Leave the account id empty only if the number was added inside the WaFlow account.', { code: 'TOKEN_REQUIRED' });
    }

    // The token to test: the new one, else the saved one, else (a number inside the platform account) the platform token.
    let testToken = token || undefined;
    if (!token && stored) testToken = readStoredToken(ws._id, stored);

    let check = null;
    if (verify) {
      check = await runCheck(deps, { phoneId, wabaId, token: testToken });
      refuseBadCheck(check, { wabaId, usingPlatformToken: !testToken, platformWaba });
    }

    const set = { 'whatsapp.phoneId': phoneId, 'whatsapp.enabled': true };
    const unset = {};
    const finalWaba = wabaId || (check && check.wabaId ? String(check.wabaId) : null);
    if (finalWaba) set['whatsapp.wabaId'] = finalWaba; else unset['whatsapp.wabaId'] = '';
    if (token) {
      set['whatsapp.tokenEncrypted'] = tokenVault.encrypt(token, { workspaceId: ws._id, purpose: 'token' });
      set['whatsapp.tokenKeyVersion'] = tokenVault.keyVersion();
    }
    if (verify) {
      const now = new Date();
      set['whatsapp.tokenIsValid'] = true; // the number answered with this token (refuseBadCheck turned every other outcome away)
      set['whatsapp.tokenCheckedAt'] = now;
      if (check.displayPhoneNumber) set['whatsapp.displayPhoneNumber'] = String(check.displayPhoneNumber); else unset['whatsapp.displayPhoneNumber'] = '';
      if (check.verifiedName) set['whatsapp.verifiedName'] = String(check.verifiedName); else unset['whatsapp.verifiedName'] = '';
    } else {
      for (const k of ['tokenIsValid', 'tokenCheckedAt', 'displayPhoneNumber', 'verifiedName']) unset[`whatsapp.${k}`] = '';
    }

    await audit(req, 'set_whatsapp', ws._id, {
      phoneIdLast4: last4(phoneId), wabaId: finalWaba, tokenProvided: !!token, keptSavedToken: !token && !!stored,
      verified: verify, previousMode: ws.whatsapp && ws.whatsapp.phoneId ? 'own' : 'platform',
    });
    const update = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;
    try {
      await Workspace.updateOne({ _id: ws._id }, update, { strict: false });
    } catch (err) {
      if (err && err.code === 11000) throw new HttpError(409, 'That phone number id is already used by another customer.', { code: 'PHONE_ID_IN_USE' });
      throw err;
    }
    deps.invalidateSender(ws._id);
    res.json({ whatsapp: whatsappStatus(await Workspace.findById(ws._id).select(WS_SELECT).lean()) });
  }));

  router.post('/tenants/:id/whatsapp/verify', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    const w = ws.whatsapp || {};
    if (!w.phoneId) throw new HttpError(409, 'This customer uses the WaFlow platform number, so there is nothing to test here.', { code: 'PLATFORM_MODE' });

    const testToken = w.tokenEncrypted ? readStoredToken(ws._id, w.tokenEncrypted) : undefined;
    const check = await runCheck(deps, { phoneId: w.phoneId, wabaId: w.wabaId || null, token: testToken });
    const bad = describeBadCheck(check, { wabaId: w.wabaId || null, usingPlatformToken: !testToken, platformWaba: String(process.env.WA_WABA_ID || '').trim() || null });
    const valid = !bad;

    await audit(req, 'verify_whatsapp', ws._id, { phoneIdLast4: last4(w.phoneId), tokenIsValid: valid, reason: bad ? bad.code : null });
    // "invalid" is recorded only when WhatsApp said the TOKEN is bad: it makes every send of this customer fail closed
    // (utils/waTenant.js), so a finding about something else (the number was not found, the account differs) is reported to the
    // person but does not switch the customer's sending off; what was recorded before stays.
    const set = { 'whatsapp.tokenCheckedAt': new Date() };
    if (valid) set['whatsapp.tokenIsValid'] = true;
    else if (bad.code === 'TOKEN_INVALID') set['whatsapp.tokenIsValid'] = false;
    if (check.phoneOk !== false) {
      if (check.displayPhoneNumber) set['whatsapp.displayPhoneNumber'] = String(check.displayPhoneNumber);
      if (check.verifiedName) set['whatsapp.verifiedName'] = String(check.verifiedName);
    }
    await Workspace.updateOne({ _id: ws._id }, { $set: set }, { strict: false });
    deps.invalidateSender(ws._id);
    const out = { whatsapp: whatsappStatus(await Workspace.findById(ws._id).select(WS_SELECT).lean()) };
    if (bad) out.message = bad.message;
    res.json(out);
  }));

  router.delete('/tenants/:id/whatsapp', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    const w = ws.whatsapp || {};
    await audit(req, 'clear_whatsapp', ws._id, { hadOwnNumber: !!w.phoneId, phoneIdLast4: last4(w.phoneId), hadToken: !!w.tokenEncrypted });
    // Back to the platform number: remove only the per-customer fields (the legacy plaintext `token` field is left alone).
    const unset = {};
    for (const k of ['phoneId', 'wabaId', 'tokenEncrypted', 'tokenKeyVersion', 'displayPhoneNumber', 'verifiedName', 'tokenIsValid', 'tokenCheckedAt', 'enabled']) unset[`whatsapp.${k}`] = '';
    await Workspace.updateOne({ _id: ws._id }, { $unset: unset }, { strict: false });
    deps.invalidateSender(ws._id);
    res.json({ whatsapp: whatsappStatus(await Workspace.findById(ws._id).select(WS_SELECT).lean()) });
  }));

  // ── enter / exit a customer ────────────────────────────────────────────────

  router.post('/tenants/:id/enter', wrap(async (req, res) => {
    const ws = await loadWorkspace(req.params.id);
    await audit(req, 'enter', ws._id, { workspaceName: ws.name });
    // No Membership row: the customer's team list, seat count and owner controls are untouched. The claims make every
    // existing route work (role owner) while middleware/requireAuth.js re-checks the allowlist on each request.
    const token = jwt.sign(
      { sub: String(req.user.id), workspaceId: String(ws._id), role: 'owner', sa: true, actAs: true },
      JWT_SECRET, { expiresIn: ENTER_TTL, issuer: ISSUER, audience: AUDIENCE },
    );
    const { exp } = jwt.decode(token);
    res.json({ token, workspace: { id: String(ws._id), name: ws.name }, expiresAt: new Date(exp * 1000).toISOString() });
  }));

  router.post('/exit', wrap(async (req, res) => {
    if (!req.user.actAs) throw new HttpError(400, 'You are not viewing a customer.');
    await audit(req, 'exit', req.user.workspaceId, {});
    res.json({ ok: true });
  }));

  // ── audit trail ────────────────────────────────────────────────────────────

  router.get('/audit', wrap(async (req, res) => {
    const filter = {};
    if (req.query.tenantId !== undefined && req.query.tenantId !== '') {
      if (!isId(String(req.query.tenantId))) throw new HttpError(400, 'tenantId is not a valid customer id.');
      filter.workspaceId = req.query.tenantId;
    }
    const asked = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LIST_LIMIT) : 50;
    const rows = await PlatformAuditLog.find(filter).sort({ _id: -1 }).limit(limit).lean();
    res.json({
      entries: rows.map((r) => ({
        id: String(r._id), action: r.action, actorUserId: String(r.actorUserId), actorLabel: r.actorLabel || '',
        workspaceId: r.workspaceId ? String(r.workspaceId) : null, ip: r.ip || null, forwardedFor: r.forwardedFor || null, userAgent: r.userAgent || null,
        detail: r.detail || {}, createdAt: r.createdAt,
      })),
    });
  }));

  return router;
}

// ── WhatsApp helpers (module level so both routes share them) ────────────────

function readStoredToken(workspaceId, envelope) {
  try {
    return tokenVault.decrypt(envelope, { workspaceId, purpose: 'token' });
  } catch (err) {
    if (err && err.code === 'ENCRYPTION_NOT_CONFIGURED') throw err; // wrap() answers 503
    throw new HttpError(409, 'The saved WhatsApp token can no longer be read. Enter the token again.', { code: 'TOKEN_UNREADABLE' });
  }
}

async function runCheck(deps, input) {
  let check;
  try {
    check = await deps.metaCheck(input);
  } catch (err) {
    console.error('[platform] WhatsApp check could not reach Meta:', err && err.message ? String(err.message).slice(0, 120) : 'error');
    throw new HttpError(502, 'We could not reach WhatsApp to check this number. Nothing was changed. Try again in a moment.', { code: 'VERIFY_UNAVAILABLE' });
  }
  if (check && check.transient === true) {
    console.error('[platform] WhatsApp check: Meta answered "try again later":', check.error ? String(check.error).slice(0, 120) : 'transient');
    throw new HttpError(502, 'WhatsApp is busy and did not give a clear answer just now. Nothing was changed. Try again in a moment.', { code: 'VERIFY_UNAVAILABLE' });
  }
  return check && typeof check === 'object' ? check : {};
}

// null when the check is fine, else { code, message } (also used to refuse a save).
function describeBadCheck(check, { wabaId, usingPlatformToken, platformWaba }) {
  if (check.tokenIsValid === false) {
    return { code: 'TOKEN_INVALID', message: 'WhatsApp says this access token is not valid or has expired.' };
  }
  if (check.phoneOk === false) {
    return { code: 'PHONE_NOT_FOUND', message: 'WhatsApp could not find that phone number id with this token. Check the phone number id, and that the token belongs to the same WhatsApp business account.' };
  }
  const reported = check.wabaId ? String(check.wabaId) : null;
  if (wabaId && reported && reported !== String(wabaId)) {
    return { code: 'WABA_MISMATCH', message: 'That phone number belongs to a different WhatsApp business account than the one entered.' };
  }
  if (usingPlatformToken && platformWaba && reported && reported !== platformWaba) {
    return { code: 'NEEDS_TOKEN', message: 'That number belongs to a different WhatsApp business account than WaFlow\'s own, so it needs its own access token.' };
  }
  return null;
}

function refuseBadCheck(check, ctx) {
  const bad = describeBadCheck(check, ctx);
  if (bad) throw new HttpError(422, `${bad.message} Nothing was saved.`, { code: bad.code, ...(check.error ? { detail: String(check.error).slice(0, 300) } : {}) });
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.defaultMetaCheck = defaultMetaCheck;
module.exports.whatsappStatus = whatsappStatus;
