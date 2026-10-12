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

// deps: { findWorkspace(id), getFlag(id), listFlags(), setFlag(args), addLog(row), adminUser, print(line) }
async function run(args, deps) {
  const { print } = deps;
  if (args.command === 'list') {
    const rows = await deps.listFlags();
    if (!rows.length) print('No workspace has a localisation record yet.');
    for (const row of rows) print(`${row.workspaceId}  ${row.name || '(unknown workspace)'}  ${describeFlag(row)}`);
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

module.exports = { parseArgs, run, describeFlag, UsageError, USAGE };
