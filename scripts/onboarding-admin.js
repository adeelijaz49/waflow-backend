'use strict';
// Staff CLI for the WhatsApp onboarding rollout (DB design 3.5). The fallback to
// /internal-admin-onboarding where INTERNAL_ADMIN_USER / INTERNAL_ADMIN_PASSWORD are not configured,
// and the runtime kill without a redeploy (`unenrol --all`).
//
//   node scripts/onboarding-admin.js list
//   node scripts/onboarding-admin.js status     <workspaceId>
//   node scripts/onboarding-admin.js enrol      <workspaceId> [--activate] [--notes "text"] [--force-oldest] [--confirm-existing-data] [--dry-run]
//   node scripts/onboarding-admin.js unenrol    <workspaceId> | --all   [--notes "text"] [--dry-run]
//   node scripts/onboarding-admin.js activate   <workspaceId> --notes "Riyadh partner" [--dry-run]
//   node scripts/onboarding-admin.js deactivate <workspaceId> [--notes "text"] [--dry-run]
//   node scripts/onboarding-admin.js funnel
//   node scripts/onboarding-admin.js deletion-done <request id> [--notes "text"]   (mark a Meta data-deletion request processed: nothing is deleted)
//   node scripts/onboarding-admin.js indexes [--create]   (list the indexes of the nine onboarding collections; --create builds the declared ones)
//
// `list` also shows the open Meta data-deletion requests. `indexes` warns loudly (exit 1) when a UNIQUE index is missing: Mongoose swallows the
// errors of its automatic index build, so run it right after switching the flag on in production (Cosmos DB for MongoDB).
//
// Exit codes: 0 ok, 1 runtime failure (unknown workspace, refused safeguard, DB error), 2 bad usage.
// It works with ONBOARDING_FLOW OFF (enrolment is data: the flag only decides whether it is acted on).
// All writes go through shared/onboarding/state.js (enrol / unenrol / unenrolAll / adminActivate /
// adminDeactivate), which writes the OnboardingAdminLog row BEFORE it mutates, so this script never
// logs those itself. It never deletes anything and never prints the connection string, a token,
// a PIN or a full phone number. The pure core (parseArgs / run) takes its dependencies by injection
// so it is unit-tested without a database; the thin wrapper at the bottom connects, runs, disconnects.
const os = require('os');
const config = require('../shared/onboarding/config');

const COMMANDS = ['list', 'status', 'enrol', 'unenrol', 'activate', 'deactivate', 'funnel', 'deletion-done', 'indexes'];
const USAGE = [
  'Usage:',
  '  node scripts/onboarding-admin.js list',
  '  node scripts/onboarding-admin.js status     <workspaceId>',
  '  node scripts/onboarding-admin.js enrol      <workspaceId> [--activate] [--notes "text"] [--force-oldest] [--confirm-existing-data] [--dry-run]',
  '  node scripts/onboarding-admin.js unenrol    <workspaceId> | --all  [--notes "text"] [--dry-run]',
  '  node scripts/onboarding-admin.js activate   <workspaceId> --notes "text" [--dry-run]',
  '  node scripts/onboarding-admin.js deactivate <workspaceId> [--notes "text"] [--dry-run]',
  '  node scripts/onboarding-admin.js funnel',
  '  node scripts/onboarding-admin.js deletion-done <request id> [--notes "text"]',
  '  node scripts/onboarding-admin.js indexes [--create]',
].join('\n');

class UsageError extends Error {}

const OLDEST_MARK = '[webhook workspace / owner]';
const MAX_NOTES = 500;
const ID_RE = /^[a-fA-F0-9]{24}$/;
const FLAGS_BY_COMMAND = {
  list: [],
  funnel: [],
  indexes: ['--create'],
  'deletion-done': ['--notes'],
  status: [],
  enrol: ['--activate', '--notes', '--force-oldest', '--confirm-existing-data', '--dry-run'],
  unenrol: ['--all', '--notes', '--dry-run'],
  activate: ['--notes', '--dry-run'],
  deactivate: ['--notes', '--dry-run'],
};
const REASON_TEXT = {
  INVALID_WORKSPACE_ID: 'That is not a valid workspace id.',
  WORKSPACE_NOT_FOUND: 'No workspace with that id.',
  OLDEST_WORKSPACE: 'Refused: this is the OLDEST workspace (the webhook workspace / the owner). Re-run with --force-oldest if you really mean it.',
  EXISTING_DATA: 'Refused: this workspace already has data (customers, orders or promotions, or it is older than ONBOARDING_ENROL_FROM). Re-run with --confirm-existing-data to enrol it anyway.',
  NOT_ENROLLED: 'This workspace is not enrolled.',
  NOTES_REQUIRED: 'Notes are required for an activation: pass --notes "why".',
};

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{command:string, workspaceId:string|null, code:string|null, notes:string|undefined, dryRun:boolean, activate:boolean, forceOldest:boolean, confirmExistingData:boolean, all:boolean, create:boolean}}
 * @throws {UsageError}
 */
function parseArgs(argv) {
  const args = { command: null, workspaceId: null, code: null, notes: undefined, dryRun: false, activate: false, forceOldest: false, confirmExistingData: false, all: false, create: false };
  const positional = [];
  const seen = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = String(list[i]);
    if (arg === '--dry-run') { args.dryRun = true; seen.push(arg); }
    else if (arg === '--activate') { args.activate = true; seen.push(arg); }
    else if (arg === '--force-oldest') { args.forceOldest = true; seen.push(arg); }
    else if (arg === '--confirm-existing-data') { args.confirmExistingData = true; seen.push(arg); }
    else if (arg === '--all') { args.all = true; seen.push(arg); }
    else if (arg === '--create') { args.create = true; seen.push(arg); }
    else if (arg === '--notes') {
      if (i + 1 >= list.length) throw new UsageError('--notes needs a value');
      args.notes = String(list[i + 1]).slice(0, MAX_NOTES);
      seen.push('--notes');
      i += 1;
    } else if (arg.startsWith('--notes=')) { args.notes = arg.slice('--notes='.length).slice(0, MAX_NOTES); seen.push('--notes'); }
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  args.command = positional[0] || null;
  args.workspaceId = positional[1] || null;
  if (!COMMANDS.includes(args.command)) throw new UsageError('Missing or unknown command');
  const bad = seen.find((f) => !FLAGS_BY_COMMAND[args.command].includes(f));
  if (bad) throw new UsageError(`Option ${bad} does not apply to "${args.command}"`);
  if (args.command === 'unenrol' && args.all && args.workspaceId) throw new UsageError('Use either a workspace id or --all, not both');
  if (args.command === 'deletion-done') {
    if (positional.length > 2) throw new UsageError('Too many arguments');
    if (!/^[a-f0-9]{16,64}$/i.test(args.workspaceId || '')) throw new UsageError('deletion-done needs the request id (the confirmation code of the data-deletion request)');
    args.code = args.workspaceId.toLowerCase();
    args.workspaceId = null;
    return args;
  }
  const needsId = !['list', 'funnel', 'indexes'].includes(args.command) && !(args.command === 'unenrol' && args.all);
  const maxPositional = needsId ? 2 : 1;
  if (positional.length > maxPositional) throw new UsageError('Too many arguments');
  if (args.command === 'unenrol' && needsId && !ID_RE.test(args.workspaceId || '')) throw new UsageError('A 24-character workspace id (or --all) is required');
  if (needsId && !ID_RE.test(args.workspaceId || '')) throw new UsageError('A 24-character workspace id is required');
  if (args.command === 'activate' && !(args.notes && args.notes.trim())) throw new UsageError('activate needs --notes "why" (for example the partner name)');
  return args;
}

function iso(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toISOString();
}

/** Remove anything that looks like a connection string from an error message before printing it. */
function redact(message) {
  return String(message === undefined || message === null ? '' : message).replace(/mongodb(\+srv)?:\/\/\S+/gi, '[redacted]').slice(0, 300);
}

async function webhookOf(deps) {
  if (typeof deps.findWebhookWorkspace !== 'function') return null;
  try {
    const w = await deps.findWebhookWorkspace();
    if (!w || !(w.workspaceId || w._id)) return null;
    return { workspaceId: String(w.workspaceId || w._id), name: w.name, createdAt: w.createdAt };
  } catch (err) {
    return null;
  }
}

function oldestWarning(webhook) {
  return `WARNING: this is the OLDEST workspace ${OLDEST_MARK}: the single WhatsApp webhook serves it and it is the owner's own workspace (${webhook.name || '(unnamed)'}, created ${iso(webhook.createdAt).slice(0, 10)}).`;
}

function funnelLines(f) {
  const lines = [`Funnel (${f.generatedAt}): ${f.enrolled} enrolled, ${f.completed} finished${f.truncated ? ' (TRUNCATED)' : ''}`];
  lines.push('step         entered  completed  skipped  median-min  drop-off(7d)');
  for (const [k, s] of Object.entries(f.steps || {})) {
    lines.push(`${k.padEnd(12)} ${String(s.entered).padStart(7)}  ${String(s.completed).padStart(9)}  ${String(s.skipped).padStart(7)}  ${String(s.medianMinutes === null || s.medianMinutes === undefined ? '-' : s.medianMinutes).padStart(10)}  ${String(s.dropOff).padStart(12)}`);
  }
  lines.push(`Subscription: ${Object.entries(f.subscription || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`Connection:   ${Object.entries(f.connection || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`Top failure codes: ${(f.failureCodes || []).map((c) => `${c.code}=${c.count}`).join(' ') || 'none'}`);
  if ((f.warnings || []).length) lines.push(`Incomplete data: ${f.warnings.join(', ')}`);
  return lines;
}

/**
 * Run one command. deps: { state, analytics, findWorkspace(id), listStates(), getState(id), getConnection(id),
 *   findWebhookWorkspace() (optional, read-only), resolveRecipient(id) (optional), adminUser, stateDeps (optional,
 *   passed to the state.js functions: models/now for tests) }.
 * @returns {Promise<{code:number, out:string, lines:string[]}>}
 */
async function run(args, deps) {
  const lines = [];
  const print = (line) => { lines.push(String(line)); };
  const finish = (code) => ({ code, out: lines.join('\n'), lines });
  const stateDeps = deps.stateDeps;
  const by = deps.adminUser || 'cli:unknown';

  try {
    if (args.command === 'list') {
      const rows = await deps.listStates();
      const webhook = await webhookOf(deps);
      const webhookListed = !!webhook && rows.some((r) => String(r.workspaceId) === webhook.workspaceId);
      if (!rows.length) print('No workspace is enrolled (or has ever been enrolled).');
      for (const r of rows) {
        const sub = r.subscription || {};
        const mark = webhook && String(r.workspaceId) === webhook.workspaceId ? `  ${OLDEST_MARK}` : '';
        const enrolled = r.enrolled === false ? 'un-enrolled' : 'ENROLLED';
        print(`${r.workspaceId}  ${r.name || '(unknown workspace)'}  ${enrolled}  sub:${sub.state || 'none'}/${sub.source || '-'}  progress:${(r.progress && r.progress.status) || '-'}  since ${iso(r.enrolledAt)}${mark}`);
      }
      if (webhook && !webhookListed) print(`${webhook.workspaceId}  ${webhook.name || '(unknown workspace)'}  legacy (not enrolled)${'  '}${OLDEST_MARK}`);
      if (webhook) print(`${OLDEST_MARK} = the OLDEST workspace: the webhook workspace and the owner's own. Enrolling it needs --force-oldest.`);
      if (typeof deps.listDeletions === 'function') {
        try {
          const lists = await deps.listDeletions();
          print(lists.open.length
            ? `OPEN Meta data-deletion requests: ${lists.open.length} (nothing is deleted automatically: process each one, then: deletion-done <request id>)`
            : 'Open Meta data-deletion requests: none');
          for (const r of lists.open) print(`  ${r.code}  received ${iso(r.receivedAt)}  workspace ${r.workspaceId || '-'}  ${r.outcome || ''}`.trimEnd());
        } catch (err) { print(`Open Meta data-deletion requests: could not be read (${redact(err && err.message)})`); }
      }
      return finish(0);
    }

    if (args.command === 'deletion-done') {
      const r = await deps.dataDeletion.markProcessed({ code: args.code, by, notes: args.notes, ip: 'cli' }, stateDeps);
      print(r.alreadyDone ? 'That data-deletion request was already marked processed.' : 'Marked processed (written to the admin log first; nothing was deleted).');
      return finish(0);
    }

    if (args.command === 'indexes') {
      let result = null;
      if (args.create) {
        const made = await deps.indexes.create();
        for (const m of made.created) print(`Indexes built for ${m.collection}`);
        for (const e of made.errors) print(`ERROR building the indexes of ${e.collection}: ${e.code} ${e.message}`);
        result = made;
      }
      const report = await deps.indexes.inspect();
      for (const c of report.collections) {
        print(`${c.collection}: ${c.exists ? 'exists' : 'does NOT exist yet (nothing has used it)'}`);
        for (const i of c.indexes) print(`    ${i.name}  ${Object.entries(i.key || {}).map(([k, v]) => `${k}:${v}`).join(', ')}${i.unique ? '  UNIQUE' : ''}`);
        for (const m of c.missing) print(`    missing: ${Object.entries(m.key || {}).map(([k, v]) => `${k}:${v}`).join(', ')}${m.unique ? '  UNIQUE  <-- !!!' : ''}`);
      }
      if (report.missingUnique.length) {
        print('');
        print('!!! WARNING: UNIQUE INDEXES ARE MISSING !!!');
        for (const m of report.missingUnique) print(`!!!   ${m.collection} { ${m.key} }`);
        print('!!! Without them one workspace can get several sidecars / connections, notifications can repeat and template rows can duplicate.');
        print(args.create ? '!!! The explicit build above did not fix it: see the errors above (nothing was dropped).' : '!!! Run again with --create to build them explicitly (it never drops anything) and see the error if the database refuses one.');
        return finish(1);
      }
      print('');
      print(`All declared UNIQUE indexes are present${result && result.errors && result.errors.length ? ' (but some builds reported errors, see above)' : ''}.`);
      return finish(result && result.errors && result.errors.length ? 1 : 0);
    }

    if (args.command === 'funnel') {
      funnelLines(await deps.analytics.funnel()).forEach(print);
      return finish(0);
    }

    if (args.command === 'unenrol' && args.all) {
      const r = await deps.state.unenrolAll({ by, notes: args.notes, dryRun: args.dryRun, ip: 'cli' }, stateDeps);
      if (r.dryRun) print(`Dry run: would un-enrol ${r.count} workspace(s). Nothing was written.`);
      else print(`Un-enrolled ${r.count} workspace(s). Rows are kept; running servers pick it up within about 30 seconds.`);
      return finish(0);
    }

    const workspace = await deps.findWorkspace(args.workspaceId);
    if (!workspace) {
      print(`No workspace with id ${args.workspaceId}.`);
      return finish(1);
    }
    print(`Workspace: ${workspace.name || args.workspaceId} (${args.workspaceId})`);
    const webhook = await webhookOf(deps);
    const isOldest = !!webhook && webhook.workspaceId === String(args.workspaceId);
    if (isOldest) print(oldestWarning(webhook));

    if (args.command === 'status') {
      const st = await deps.getState(args.workspaceId);
      if (!st || st.enrolled === false) {
        print(st ? `Enrolment: un-enrolled ${iso(st.unenrolledAt)} by ${st.unenrolledBy || '-'}` : 'Enrolment: not enrolled (legacy workspace: nothing is gated).');
        return finish(0);
      }
      const sub = st.subscription || {};
      const stripe = sub.stripe || {};
      const admin = sub.admin || {};
      const prog = st.progress || {};
      const num = st.number || {};
      print(`Enrolment: ENROLLED ${iso(st.enrolledAt)} via ${st.enrolledVia || '-'} by ${st.enrolledBy || '-'} (R1 applied: ${st.r1Applied ? 'yes' : 'no'})`);
      print(`Subscription: ${sub.state || 'none'} (source ${sub.source || '-'}), raw Stripe status ${stripe.status || '-'}, period ends ${iso(stripe.currentPeriodEnd)}`);
      print(`Admin activation: ${admin.active ? `active, by ${admin.by || '-'} on ${iso(admin.at)}, notes: ${admin.notes || '-'}` : 'none'}`);
      print(`Progress: ${prog.status || 'in_progress'}, current step ${prog.currentStep || 1}, last activity ${iso(prog.lastActivityAt)}, completed ${iso(prog.completedAt)}`);
      for (const k of config.STEP_KEYS) {
        const s = (st.steps && st.steps[k]) || {};
        print(`  step ${k}: ${s.status || 'todo'} (entered ${iso(s.enteredAt)}, completed ${iso(s.completedAt)})`);
      }
      print(`Number: path ${num.path || '-'}, usage ${num.usage || '-'}, ready ${num.numberReady ? 'yes' : 'no'}, reminders sent ${num.reminderCount || 0}`);
      const conn = await deps.getConnection(args.workspaceId);
      if (!conn) print('Connection: no record yet');
      else {
        const disp = conn.display || {};
        const masked = disp.displayPhoneNumber ? config.maskPhone(disp.displayPhoneNumber) : (disp.last4 ? `****${disp.last4}` : '-');
        print(`Connection: ${conn.status || '-'}${conn.needsReconnect ? ` (needs reconnect: ${conn.reconnectReason || 'unknown'})` : ''}, number ${masked}, token valid ${conn.tokenIsValid === undefined || conn.tokenIsValid === null ? 'unknown' : conn.tokenIsValid ? 'yes' : 'no'}, token expires ${iso(conn.tokenExpiresAt)}, last check ${iso(conn.lastStatusCheckAt)}`);
      }
      if (typeof deps.resolveRecipient === 'function') {
        try {
          const r = await deps.resolveRecipient(args.workspaceId);
          print(r ? 'E-mail on file: yes' : 'WARNING: no e-mail on file (phone-only account): in-app notifications only.');
        } catch (err) { print('E-mail on file: could not be determined'); }
      }
      return finish(0);
    }

    if (args.command === 'enrol') {
      const r = await deps.state.enrol({
        workspaceId: args.workspaceId, via: 'admin', by, notes: args.notes, ip: 'cli', dryRun: args.dryRun,
        activate: args.activate, forceOldest: args.forceOldest, confirmExistingData: args.confirmExistingData,
      }, stateDeps);
      (r.warnings || []).forEach((w) => print(`Note: ${w}`));
      if (r.dryRun) {
        print(r.alreadyEnrolled
          ? 'Dry run: already enrolled; enrolling again would change nothing. Nothing was written.'
          : `Dry run: would enrol this workspace${args.activate ? ' and admin-activate its subscription' : ''}. All safeguards passed. Nothing was written.`);
      } else if (r.alreadyEnrolled && !args.activate) {
        print('Already enrolled; nothing to do.');
      } else {
        print(`${r.alreadyEnrolled ? 'Already enrolled' : 'Enrolled'}${r.activated ? ' and admin-activated' : ''}${r.r1Applied ? ' (the existing wizard was marked completed)' : ''}.`);
        print('Note: it only takes effect while ONBOARDING_FLOW=on; running servers pick the change up within about 30 seconds.');
      }
      return finish(0);
    }

    if (args.command === 'unenrol') {
      const r = await deps.state.unenrol({ workspaceId: args.workspaceId, by, notes: args.notes, ip: 'cli', dryRun: args.dryRun }, stateDeps);
      if (!r.wasEnrolled) print('Not enrolled; nothing to do.');
      else if (r.dryRun) print('Dry run: would un-enrol this workspace. Nothing was written.');
      else print('Un-enrolled. The record is kept; running servers pick it up within about 30 seconds.');
      return finish(0);
    }

    if (args.command === 'activate') {
      const r = await deps.state.adminActivate({ workspaceId: args.workspaceId, by, notes: args.notes, ip: 'cli', dryRun: args.dryRun }, stateDeps);
      print(`${r.dryRun ? 'Dry run: would change' : 'Subscription'} ${r.before.state} -> ${r.after.state}${r.dryRun ? '. Nothing was written.' : '.'}`);
      return finish(0);
    }

    if (args.command === 'deactivate') {
      const r = await deps.state.adminDeactivate({ workspaceId: args.workspaceId, by, notes: args.notes, ip: 'cli', dryRun: args.dryRun }, stateDeps);
      print(`${r.dryRun ? 'Dry run: would change' : 'Subscription'} ${r.before.state} -> ${r.after.state}${r.dryRun ? '. Nothing was written.' : '.'}`);
      return finish(0);
    }
    return finish(2);
  } catch (err) {
    const reason = err && err.details && err.details.reason;
    if (err && err.code === 'VALIDATION_FAILED' && reason && REASON_TEXT[reason]) {
      const extra = Array.isArray(err.details.reasons) && err.details.reasons.length ? ` (${err.details.reasons.join(', ')})` : '';
      print(`${REASON_TEXT[reason]}${extra}`);
      return finish(1);
    }
    print(`Failed: ${redact(err && err.message)}`);
    return finish(1);
  }
}

const STATE_FIELDS = 'workspaceId enrolled enrolledAt enrolledVia enrolledBy unenrolledAt unenrolledBy r1Applied subscription progress steps number';
const CONNECTION_FIELDS = [
  'status', 'display.displayPhoneNumber', 'display.last4', 'tokenExpiresAt', 'tokenIsValid', 'needsReconnect', 'reconnectReason', 'lastStatusCheckAt',
].join(' ');

function buildDeps() {
  const Workspace = require('../models/Workspace');
  const OnboardingState = require('../models/OnboardingState');
  const WhatsAppConnection = require('../models/WhatsAppConnection');
  let osUser = 'unknown';
  try { osUser = os.userInfo().username; } catch (err) { /* no passwd entry in some containers */ }
  return {
    adminUser: `cli:${osUser}`,
    state: require('../shared/onboarding/state'),
    analytics: require('../shared/onboarding/analytics'),
    dataDeletion: require('../shared/onboarding/dataDeletion'),
    indexes: require('../shared/onboarding/indexCheck'),
    listDeletions: () => require('../shared/onboarding/dataDeletion').listRequests(),
    findWorkspace: (id) => Workspace.findById(id).select('name createdAt').lean(),
    getState: (id) => OnboardingState.findOne({ workspaceId: id }).select(STATE_FIELDS).lean(),
    getConnection: (id) => WhatsAppConnection.findOne({ workspaceId: id }).select(CONNECTION_FIELDS).lean(),
    resolveRecipient: (id) => require('../shared/onboarding/email').resolveRecipient({ workspaceId: id }),
    // READ-ONLY, same query as server.js resolveWebhookWorkspaceId (single-field sort: Cosmos-safe).
    async findWebhookWorkspace() {
      const w = await Workspace.findOne().sort({ createdAt: 1 }).select('name createdAt').lean();
      return w ? { workspaceId: String(w._id), name: w.name, createdAt: w.createdAt } : null;
    },
    async listStates() {
      // Sorted here, not by the database: Cosmos DB rejects a multi-field sort without a compound index.
      const rows = (await OnboardingState.find({}).select(STATE_FIELDS).limit(500).lean())
        .sort((a, b) => (Number(b.enrolled !== false) - Number(a.enrolled !== false)) || (new Date(b.enrolledAt || 0) - new Date(a.enrolledAt || 0)));
      const names = await Workspace.find({ _id: { $in: rows.map((r) => r.workspaceId) } }).select('name').lean();
      const byId = new Map(names.map((w) => [String(w._id), w.name]));
      return rows.map((r) => ({ ...r, workspaceId: String(r.workspaceId), name: byId.get(String(r.workspaceId)) }));
    },
  };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  require('dotenv').config();
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set.');
    return 1;
  }
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const result = await run(args, buildDeps());
    if (result.out) console.log(result.out);
    return result.code;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('Failed:', redact(err && err.message)); process.exitCode = 1; });
}

module.exports = { parseArgs, run, buildDeps, main, redact, UsageError, USAGE, OLDEST_MARK };
