'use strict';
// Meta data-deletion requests as staff see them (review R7-11). metaCallbacks.js records every verified request as an OnboardingInbound ledger
// row (_id 'metacb:<code>', type 'data_deletion', status 'processing', outcome 'awaiting_staff user:<id>') and answers Meta with the status URL.
// NOTHING is deleted automatically (standing rule): a human processes the request with the internal admin tooling and then marks it processed
// HERE (status 'done', nothing is deleted, the action is written to the admin log BEFORE the row changes). Used by the admin page
// (routes/adminOnboarding.js) and the CLI (scripts/onboarding-admin.js).
//
//   listRequests(deps)            { open:[row], done:[row] } (open first, newest first; bounded)
//   markProcessed(args, deps)     { ok:true, code, alreadyDone }  (VALIDATION_FAILED reasons: INVALID_CODE, NOT_FOUND)
//
// row = { code, status, receivedAt, workspaceId|null, outcome }
// Injectable deps: OnboardingInbound, OnboardingAdminLog, now. Models are loaded lazily; nothing runs at require time.
const config = require('./config');
const { OnbError } = require('./errors');

const CODE_RE = /^[a-f0-9]{16,64}$/;
const OPEN_LIMIT = 50;
const DONE_LIMIT = 20;
const MAX_NOTES = 500;

const Inbound = (deps) => (deps && deps.OnboardingInbound) || require('../../models/OnboardingInbound');
const AdminLog = (deps) => (deps && deps.OnboardingAdminLog) || require('../../models/OnboardingAdminLog');
const nowOf = (deps) => (deps && typeof deps.now === 'function' ? new Date(deps.now()) : new Date());
const invalid = (reason) => new OnbError('VALIDATION_FAILED', { details: { reason } });

function view(row) {
  const id = String((row && row._id) || '');
  return {
    code: id.replace(/^metacb:/, ''),
    status: row.status || 'processing',
    receivedAt: row.startedAt || null,
    workspaceId: row.workspaceId ? String(row.workspaceId) : null,
    outcome: typeof row.outcome === 'string' ? row.outcome : '',
  };
}

const byNewest = (a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0);

/**
 * The open requests (not yet marked processed) and the most recently processed ones. Two reads through the status index (no multi-field sort,
 * no collection scan of the whole ledger); the order is applied here.
 * @param {object} [deps]
 * @returns {Promise<{open:object[], done:object[]}>}
 */
async function listRequests(deps) {
  const fields = '_id status workspaceId startedAt outcome';
  const open = await Inbound(deps).find({ type: 'data_deletion', status: 'processing' }).select(fields).limit(OPEN_LIMIT).lean();
  const done = await Inbound(deps).find({ type: 'data_deletion', status: 'done' }).select(fields).limit(DONE_LIMIT).lean();
  return { open: (open || []).map(view).sort(byNewest), done: (done || []).map(view).sort(byNewest) };
}

/**
 * Mark one request processed: the admin log row is written FIRST (a failing log = nothing changed), then the ledger row becomes 'done'
 * (finishedAt, outcome 'processed_by_staff ...'). Idempotent. Nothing is deleted.
 * @param {{code:string, by:string, notes?:string, ip?:string}} args
 * @param {object} [deps]
 * @returns {Promise<{ok:true, code:string, alreadyDone:boolean}>}
 */
async function markProcessed({ code, by, notes, ip } = {}, deps) {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
  if (!CODE_RE.test(c)) throw invalid('INVALID_CODE');
  const _id = `metacb:${c}`;
  const row = await Inbound(deps).findOne({ _id, type: 'data_deletion' }).select('_id status workspaceId startedAt outcome').lean();
  if (!row) throw invalid('NOT_FOUND');
  if (row.status === 'done') return { ok: true, code: c, alreadyDone: true };
  const cleanBy = typeof by === 'string' && by.replace(/[\u{0}-\u{1f}\u{7f}]/gu, '').trim().slice(0, 80) ? by.replace(/[\u{0}-\u{1f}\u{7f}]/gu, '').trim().slice(0, 80) : 'unknown';
  const cleanNotes = typeof notes === 'string' ? notes.replace(/[\u{0}-\u{1f}\u{7f}]/gu, ' ').trim().slice(0, MAX_NOTES) : '';
  const now = nowOf(deps);
  await AdminLog(deps).create({
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    action: 'data_deletion_done', target: _id, adminUser: cleanBy, notes: cleanNotes, ip,
    before: { status: row.status || 'processing' }, after: { status: 'done' },
  });
  const outcome = String(row.outcome || 'awaiting_staff').replace(/^awaiting_staff/, 'processed_by_staff').slice(0, 120);
  await Inbound(deps).updateOne({ _id, type: 'data_deletion' }, { $set: { status: 'done', finishedAt: now, outcome } });
  config.safeLog('info', '[onboarding] data-deletion request marked processed:', c);
  return { ok: true, code: c, alreadyDone: false };
}

module.exports = { listRequests, markProcessed, CODE_RE };
