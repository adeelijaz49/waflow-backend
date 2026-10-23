'use strict';
// In-app notifications of the onboarding flow + optional e-mail (DB design 7.1).
// notify() is idempotent through the unique {workspaceId, dedupeKey} index
// (E11000 = already notified = no-op, no second e-mail) and NEVER throws or
// blocks the caller's state change. E-mail goes through the lazily required
// ./email module (B1-f) and is not awaited by notify (the returned
// emailPromise never rejects).
const { safeLog } = require('./config');

const KINDS = Object.freeze([
  'payment_failed', 'subscription_active', 'subscription_cancelled', 'connected', 'reconnect_needed',
  'verification_changed', 'display_name_decided', 'messaging_limit_changed', 'template_approved', 'template_rejected',
  'pathb_reminder', 'sending_paused', 'account_alert', 'help_received',
]);
const SEVERITIES = Object.freeze(['info', 'success', 'warning', 'action']);
const MAX_EMAIL_ATTEMPTS = 3;
const ID_RE = /^[0-9a-f]{24}$/i;

function realModel() { return require('../../models/OnboardingNotification'); }

function cleanParams(params) {
  const out = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const k of Object.keys(params).slice(0, 8)) {
    const v = params[k];
    if (typeof v === 'string') out[k] = v.slice(0, 80);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function toRow(doc) {
  return {
    id: String(doc._id),
    kind: doc.kind,
    severity: doc.severity,
    titleKey: doc.titleKey,
    bodyKey: doc.bodyKey,
    params: doc.params || {},
    actionPath: doc.actionPath || null,
    createdAt: doc.createdAt || null,
    readAt: doc.readAt || null,
  };
}

async function resolve(q) {
  let query = q;
  if (query && typeof query.lean === 'function') query = query.lean();
  return query;
}

/** @param {{model?:object, email?:object, emailDeps?:object, now?:()=>Date}} [deps] */
function createNotifications(deps = {}) {
  const now = deps.now || (() => new Date());
  const getModel = () => deps.model || realModel();
  const getEmail = () => deps.email || require('./email');

  async function dispatchEmail(model, doc, opt) {
    try {
      const to = opt && typeof opt === 'object' ? opt.to : undefined;
      const language = opt && typeof opt === 'object' ? opt.language : undefined;
      await model.updateOne({ _id: doc._id }, { $inc: { emailAttempts: 1 } });
      const res = await getEmail().sendNotificationEmail({
        workspaceId: String(doc.workspaceId), notification: toRow(doc), kind: doc.kind, params: doc.params || {}, to, language,
      }, deps.emailDeps);
      if (res && res.sent) {
        await model.updateOne({ _id: doc._id }, { $set: { emailSentAt: now() }, $unset: { emailError: 1 } });
        return { sent: true, id: res.id };
      }
      const reason = res && res.skipped ? String(res.skipped).slice(0, 40) : 'not_sent';
      await model.updateOne({ _id: doc._id }, { $set: { emailError: `skipped:${reason}`, emailAttempts: MAX_EMAIL_ATTEMPTS } });
      return { sent: false, skipped: reason };
    } catch (err) {
      try {
        await model.updateOne({ _id: doc._id }, { $set: { emailError: String((err && err.code) || 'send_failed').slice(0, 40) } });
      } catch (_) { /* bookkeeping must never throw */ }
      safeLog('warn', '[onboarding] notification e-mail failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
      return { sent: false, error: (err && err.code) || 'send_failed' };
    }
  }

  /**
   * @param {{workspaceId:string, kind:string, dedupeKey:string, params?:object, email?:boolean|{to?:string,language?:string}, severity?:string, actionPath?:string}} args
   * @returns {Promise<{created:boolean, notification:object|null, emailPromise:Promise<object>|null}>}
   */
  async function notify(args) {
    const none = { created: false, notification: null, emailPromise: null };
    try {
      const a = args || {};
      if (!ID_RE.test(String(a.workspaceId || ''))) { safeLog('warn', '[onboarding] notify: invalid workspaceId'); return none; }
      if (!KINDS.includes(a.kind)) { safeLog('warn', '[onboarding] notify: unknown kind', String(a.kind).slice(0, 40)); return none; }
      const dedupeKey = typeof a.dedupeKey === 'string' ? a.dedupeKey.slice(0, 200) : '';
      if (!dedupeKey) { safeLog('warn', '[onboarding] notify: dedupeKey required'); return none; }
      const severity = SEVERITIES.includes(a.severity) ? a.severity : 'info';
      const actionPath = typeof a.actionPath === 'string' && a.actionPath.startsWith('/') ? a.actionPath.slice(0, 200) : '/setup';
      const model = getModel();

      const existing = await resolve(model.findOne({ workspaceId: a.workspaceId, dedupeKey }));
      if (existing) return { created: false, notification: toRow(existing), emailPromise: null };

      let doc;
      try {
        doc = await model.create({
          workspaceId: a.workspaceId, dedupeKey, kind: a.kind, severity,
          titleKey: `onboarding.notify.${a.kind}.title`, bodyKey: `onboarding.notify.${a.kind}.body`,
          params: cleanParams(a.params), actionPath,
        });
      } catch (err) {
        if (err && err.code === 11000) {
          const dup = await resolve(model.findOne({ workspaceId: a.workspaceId, dedupeKey })).catch(() => null);
          return { created: false, notification: dup ? toRow(dup) : null, emailPromise: null };
        }
        throw err;
      }
      const plain = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
      const emailPromise = a.email ? dispatchEmail(model, plain, a.email) : null;
      return { created: true, notification: toRow(plain), emailPromise };
    } catch (err) {
      safeLog('warn', '[onboarding] notify failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
      return none;
    }
  }

  /** Re-send e-mails that failed (< MAX_EMAIL_ATTEMPTS). Called by the scheduler. */
  async function retryEmails(opts = {}) {
    const result = { attempted: 0, sent: 0 };
    try {
      const model = getModel();
      const limit = Math.max(1, Math.min(100, opts.limit || 20));
      const rows = await resolve(model.find({
        emailError: { $exists: true, $nin: [null, ''] }, emailSentAt: null, emailAttempts: { $lt: MAX_EMAIL_ATTEMPTS },
      }).limit(limit));
      for (const doc of rows || []) {
        if (String(doc.emailError || '').startsWith('skipped:')) continue;
        result.attempted += 1;
        const r = await dispatchEmail(model, doc, null);
        if (r.sent) result.sent += 1;
      }
    } catch (err) {
      safeLog('warn', '[onboarding] retryEmails failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
    }
    return result;
  }

  async function list(workspaceId, opts = {}) {
    try {
      if (!ID_RE.test(String(workspaceId || ''))) return [];
      const limit = Math.max(1, Math.min(30, Number(opts.limit) || 30));
      const filter = { workspaceId };
      if (opts.unread) filter.readAt = null;
      const rows = await getModel().find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      return (rows || []).map(toRow);
    } catch (err) {
      safeLog('warn', '[onboarding] notifications list failed:', err && err.message ? err.message : '');
      return [];
    }
  }

  async function markRead(workspaceId, opts = {}) {
    try {
      if (!ID_RE.test(String(workspaceId || ''))) return { modified: 0 };
      const filter = { workspaceId, readAt: null };
      if (!opts.all) {
        const ids = (Array.isArray(opts.ids) ? opts.ids : []).map(String).filter((i) => ID_RE.test(i)).slice(0, 100);
        if (!ids.length) return { modified: 0 };
        filter._id = { $in: ids };
      }
      const res = await getModel().updateMany(filter, { $set: { readAt: now() } });
      return { modified: (res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified)) || 0 };
    } catch (err) {
      safeLog('warn', '[onboarding] markRead failed:', err && err.message ? err.message : '');
      return { modified: 0 };
    }
  }

  async function unreadCount(workspaceId) {
    try {
      if (!ID_RE.test(String(workspaceId || ''))) return 0;
      return Number(await getModel().countDocuments({ workspaceId, readAt: null })) || 0;
    } catch (_) {
      return 0;
    }
  }

  return { notify, retryEmails, list, markRead, unreadCount };
}

const real = createNotifications();
const pick = (deps) => (deps ? createNotifications(deps) : real);

module.exports = {
  /** notify(args, deps?) - see INTERFACES 0.6 */
  notify: (args, deps) => pick(deps).notify(args),
  retryEmails: (opts, deps) => pick(deps).retryEmails(opts),
  list: (workspaceId, opts, deps) => pick(deps).list(workspaceId, opts),
  markRead: (workspaceId, opts, deps) => pick(deps).markRead(workspaceId, opts),
  unreadCount: (workspaceId, deps) => pick(deps).unreadCount(workspaceId),
  createNotifications, KINDS, SEVERITIES, MAX_EMAIL_ATTEMPTS,
};
