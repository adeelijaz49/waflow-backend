'use strict';
// Staff CLI for the per-merchant Arabic flag (LocaleSettings.arabicEnabled).
// It is the fallback to /internal-admin-localization for environments where
// INTERNAL_ADMIN_USER / INTERNAL_ADMIN_PASSWORD are not configured.
//
//   node scripts/localization-flag.js list
//   node scripts/localization-flag.js status  <workspaceId>
//   node scripts/localization-flag.js enable  <workspaceId> [--notes "KSA pilot"] [--dry-run]
//   node scripts/localization-flag.js disable <workspaceId> [--notes "..."]       [--dry-run]
//
// Exit codes: 0 ok, 1 runtime failure (unknown workspace, DB error), 2 bad usage.
// Writes go through the same service as the admin page (settings.setArabicEnabled)
// plus a LocalizationAdminLog row (written FIRST: log-before-mutate). Nothing here ever deletes, and the connection
// string is never printed. The pure core (parseArgs / run) takes its dependencies
// by injection so it is unit-tested without a database; the thin wrapper at the
// bottom connects, runs and disconnects.
//
// The production WhatsApp webhook is single-workspace: server.js resolveWebhookWorkspaceId() serves
// the OLDEST workspace (single-field sort on createdAt). Arabic in WhatsApp conversations therefore
// only reaches that workspace, so `list` always shows it (marked) and `status` / `enable` print a
// WARNING (never an error: the owner may still proceed) when the chosen workspace is another one.
// The lookup is one read-only query and fails soft (no warning if it cannot be answered).
const os = require('os');

const COMMANDS = ['list', 'status', 'enable', 'disable'];
const USAGE = [
  'Usage:',
  '  node scripts/localization-flag.js list',
  '  node scripts/localization-flag.js status  <workspaceId>',
  '  node scripts/localization-flag.js enable  <workspaceId> [--notes "text"] [--dry-run]',
  '  node scripts/localization-flag.js disable <workspaceId> [--notes "text"] [--dry-run]',
].join('\n');

class UsageError extends Error {}

const WEBHOOK_MARK = '[webhook workspace]';

function describeWebhookWorkspace(webhook) {
  const created = webhook.createdAt && !Number.isNaN(new Date(webhook.createdAt).getTime())
    ? `, created ${new Date(webhook.createdAt).toISOString().slice(0, 10)}` : '';
  return `${webhook.name || '(unnamed workspace)'} (${webhook.workspaceId}${created})`;
}

// Same wording is used on the /internal-admin-localization page (routes/adminLocalization.js).
function webhookWarning(webhook) {
  return 'WARNING: Arabic in WhatsApp conversations only reaches the OLDEST workspace, because the single WhatsApp '
    + `webhook serves that workspace only: ${describeWebhookWorkspace(webhook)}. `
    + 'This workspace is not the oldest one, so inbound WhatsApp conversations (replies, shopping journey, STOP/START) '
    + 'will not use Arabic for it. You may still proceed.';
}

function parseArgs(argv) {
  const args = { command: null, workspaceId: null, notes: undefined, dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--notes') {
      if (i + 1 >= argv.length) throw new UsageError('--notes needs a value');
      args.notes = String(argv[i + 1]).slice(0, 500);
      i += 1;
    } else if (arg.startsWith('--notes=')) args.notes = arg.slice('--notes='.length).slice(0, 500);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  [args.command, args.workspaceId] = positional;
  if (!COMMANDS.includes(args.command)) throw new UsageError('Missing or unknown command');
  if (positional.length > (args.command === 'list' ? 1 : 2)) throw new UsageError('Too many arguments');
  if (args.command !== 'list' && !/^[a-fA-F0-9]{24}$/.test(args.workspaceId || '')) {
    throw new UsageError('A 24-character workspace id is required');
  }
  return args;
}

function describeFlag(flag) {
  const f = flag || {};
  const parts = [f.arabicEnabled ? 'ENABLED' : 'disabled'];
  if (f.arabicEnabledAt) parts.push(`since ${new Date(f.arabicEnabledAt).toISOString()}`);
  if (f.arabicEnabledBy) parts.push(`by ${f.arabicEnabledBy}`);
  if (f.notes) parts.push(`notes: ${f.notes}`);
  return parts.join(' | ');
}

// The oldest workspace (the webhook one) as { workspaceId, name, createdAt } or null. Optional dependency
// (older callers/tests omit it) and fail-soft: an error here must never block the command.
async function lookupWebhookWorkspace(deps) {
  if (typeof deps.findWebhookWorkspace !== 'function') return null;
  try {
    const w = await deps.findWebhookWorkspace();
    if (!w || !(w.workspaceId || w._id)) return null;
    return { workspaceId: String(w.workspaceId || w._id), name: w.name, createdAt: w.createdAt };
  } catch (err) {
    return null;
  }
}

// deps: { findWorkspace(id), getFlag(id), listFlags(), setFlag(args), addLog(row), adminUser, print(line),
//         findWebhookWorkspace() (optional, read-only) }
async function run(args, deps) {
  const { print } = deps;
  if (args.command === 'list') {
    const rows = await deps.listFlags();
    const webhook = await lookupWebhookWorkspace(deps);
    const webhookListed = !!webhook && rows.some((row) => String(row.workspaceId) === webhook.workspaceId);
    if (!rows.length && !webhook) print('No workspace has a localisation record yet.');
    for (const row of rows) {
      const mark = webhook && String(row.workspaceId) === webhook.workspaceId ? `  ${WEBHOOK_MARK}` : '';
      print(`${row.workspaceId}  ${row.name || '(unknown workspace)'}  ${describeFlag(row)}${mark}`);
    }
    if (webhook && !webhookListed) {
      print(`${webhook.workspaceId}  ${webhook.name || '(unknown workspace)'}  disabled (no localisation record yet)  ${WEBHOOK_MARK}`);
    }
    if (webhook) print(`${WEBHOOK_MARK} = the OLDEST workspace: the only one that Arabic in WhatsApp conversations reaches.`);
    return 0;
  }

  const workspace = await deps.findWorkspace(args.workspaceId);
  if (!workspace) {
    print(`No workspace with id ${args.workspaceId}.`);
    return 1;
  }
  const before = await deps.getFlag(args.workspaceId);
  print(`Workspace: ${workspace.name || args.workspaceId} (${args.workspaceId})`);
  print(`Before:    ${describeFlag(before)}`);
  const webhook = await lookupWebhookWorkspace(deps);
  if (webhook) {
    if (webhook.workspaceId === String(args.workspaceId)) print(`This is the webhook workspace (the OLDEST workspace): Arabic in WhatsApp conversations reaches it.`);
    else print(webhookWarning(webhook));
  }
  if (args.command === 'status') return 0;

  const enabled = args.command === 'enable';
  if (!!(before && before.arabicEnabled) === enabled && args.notes === undefined) {
    print(`Already ${enabled ? 'enabled' : 'disabled'}; nothing to do.`);
    return 0;
  }
  if (args.dryRun) {
    print(`Dry run: would ${args.command} Arabic for this workspace. Nothing was written.`);
    return 0;
  }
  // Log BEFORE mutate (same rule as the admin page and shared/consent.js): if the audit row
  // cannot be written this throws and the flag is left untouched.
  await deps.addLog({
    workspaceId: args.workspaceId, action: args.command, adminUser: deps.adminUser, notes: args.notes || '', ip: 'cli',
  });
  const after = await deps.setFlag({
    workspaceId: args.workspaceId, enabled, grantedBy: deps.adminUser, notes: args.notes,
  });
  print(`After:     ${describeFlag(after)}`);
  print('Note: running servers pick the change up within about 30 seconds.');
  return 0;
}

function buildDeps(print) {
  const Workspace = require('../models/Workspace');
  const LocaleSettings = require('../models/LocaleSettings');
  const LocalizationAdminLog = require('../models/LocalizationAdminLog');
  const settings = require('../shared/localization/settings');
  let osUser = 'unknown';
  try { osUser = os.userInfo().username; } catch (err) { /* no passwd entry in some containers */ }
  return {
    adminUser: `cli:${osUser}`,
    print,
    findWorkspace: (id) => Workspace.findById(id).select('name').lean(),
    getFlag: (id) => LocaleSettings.findOne({ workspaceId: id }).lean(),
    // READ-ONLY, same query as server.js resolveWebhookWorkspaceId (single-field sort: Cosmos-safe).
    async findWebhookWorkspace() {
      const w = await Workspace.findOne().sort({ createdAt: 1 }).select('name createdAt').lean();
      return w ? { workspaceId: String(w._id), name: w.name, createdAt: w.createdAt } : null;
    },
    async listFlags() {
      // Sorted here, not by the database: Cosmos DB rejects a multi-field sort without a compound index.
      const rows = (await LocaleSettings.find({}).limit(500).lean())
        .sort((a, b) => (Number(!!b.arabicEnabled) - Number(!!a.arabicEnabled)) || (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)));
      const names = await Workspace.find({ _id: { $in: rows.map((r) => r.workspaceId) } }).select('name').lean();
      const byId = new Map(names.map((w) => [String(w._id), w.name]));
      return rows.map((r) => ({ ...r, workspaceId: String(r.workspaceId), name: byId.get(String(r.workspaceId)) }));
    },
    setFlag: (a) => settings.setArabicEnabled(a),
    addLog: (row) => LocalizationAdminLog.create(row),
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
    return await run(args, buildDeps((line) => console.log(line)));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('Failed:', err && err.message); process.exitCode = 1; });
}

module.exports = { parseArgs, run, describeFlag, webhookWarning, UsageError, USAGE, WEBHOOK_MARK };
