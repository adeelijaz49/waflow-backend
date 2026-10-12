#!/usr/bin/env node
'use strict';
// Native-review CLI for the BACKEND Arabic strings (spec §8): export them to a
// CSV the owner's partner reviews in a spreadsheet, then import it back.
//
//   node scripts/i18n-review.js export --out review.csv [--only-unreviewed] [--namespace consent]
//   node scripts/i18n-review.js import --in review.csv [--dry-run] [--strict] [--reviewer "Name"]
//   node scripts/i18n-review.js summary
//
// Sources: shared/localization/catalog/*.json (key "<ns>.<key>") and the
// template-library strings (read-only rows with apply=manual: edit
// templateLibrary.js by hand). All logic lives in shared/localization/reviewExport.js;
// this file only does disk I/O. It never connects to a database or the network and
// never deletes anything.
const fs = require('fs');
const path = require('path');
const { decodeCsvBuffer } = require('../shared/localization/csv');
const { buildState, exportCsv, planImport, applyUpdates } = require('../shared/localization/reviewExport');

const CATALOG_DIR = path.join(__dirname, '..', 'shared', 'localization', 'catalog');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const name = a.slice(2);
    if (['only-unreviewed', 'dry-run', 'strict'].includes(name)) args[name] = true;
    else { args[name] = argv[i + 1]; i += 1; }
  }
  return args;
}

function readCatalogFiles() {
  const texts = {};
  for (const file of fs.readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json')).sort()) {
    texts[file.slice(0, -'.json'.length)] = fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8');
  }
  return texts;
}

function loadState(texts) {
  const parsed = {};
  for (const ns of Object.keys(texts)) parsed[ns] = JSON.parse(texts[ns]);
  const { listLibraryStrings } = require('../shared/localization/templateLibrary');
  return buildState(parsed, listLibraryStrings());
}

function need(args, name) {
  if (!args[name]) { console.error(`Missing --${name}`); process.exit(2); }
  return args[name];
}

function runExport(args) {
  const state = loadState(readCatalogFiles());
  const { csv, count } = exportCsv(state, { onlyUnreviewed: !!args['only-unreviewed'], namespace: args.namespace || null });
  fs.writeFileSync(path.resolve(need(args, 'out')), csv, 'utf8');
  console.log(`Exported ${count} string(s) to ${args.out}`);
  return 0;
}

function runImport(args) {
  const texts = readCatalogFiles();
  const state = loadState(texts);
  const { text } = decodeCsvBuffer(fs.readFileSync(path.resolve(need(args, 'in'))));
  const plan = planImport(text, state, { reviewer: args.reviewer, strict: !!args.strict });
  for (const r of plan.results) {
    if (r.outcome === 'rejected') console.error(`REJECTED line ${r.line} ${r.key || '(no key)'}: ${r.reasons.join('; ')}`);
    else if (r.notes.length) console.log(`note ${r.key}: ${r.notes.join('; ')}`);
  }
  const s = plan.summary;
  console.log(`updated ${s.updated}, unchanged ${s.unchanged}, rejected ${s.rejected}${s.blockedByStrict ? ` (strict: ${s.blockedByStrict} valid row(s) not applied)` : ''}`);
  if (s.reviewedWithEdits.length) console.log(`reviewed with edited text: ${s.reviewedWithEdits.join(', ')}`);
  if (!args['dry-run'] && plan.updates.length) {
    const written = applyUpdates(texts, plan.updates);
    for (const ns of Object.keys(written)) fs.writeFileSync(path.join(CATALOG_DIR, `${ns}.json`), written[ns], 'utf8');
    console.log(`wrote ${Object.keys(written).length} file(s)`);
  } else if (args['dry-run']) {
    console.log('dry run: nothing written');
  }
  return s.rejected ? 1 : 0;
}

function runSummary() {
  const state = loadState(readCatalogFiles());
  const rows = Array.from(state.values()).filter((e) => e.arabic);
  const reviewed = rows.filter((e) => e.status === 'reviewed').length;
  console.log(`Arabic strings ${rows.length}: reviewed ${reviewed}, draft ${rows.length - reviewed}`);
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);
  const commands = { export: runExport, import: runImport, summary: runSummary };
  const run = commands[args._[0]];
  if (!run) {
    console.error('Usage: i18n-review.js export|import|summary (see the header of this file)');
    return 2;
  }
  try {
    return run(args);
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, main };
