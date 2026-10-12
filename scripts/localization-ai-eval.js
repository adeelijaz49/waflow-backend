'use strict';
// Runs the Arabic AI Mode evaluation (spec §6) against the REAL Claude API and
// writes docs/localization/AI-MODE-EVAL.md and .json (plus a run-history copy).
//
// THIS SCRIPT SPENDS MONEY (a few US dollars per full run): it is the one
// deliberate real-Claude use the owner's spec asks for ("build an evaluation set,
// run it, report results and failures"). Everything around the model is a
// simulation: no database, no WhatsApp, no Stripe (see evalRunner.js).
//
// Usage (from the backend folder):
//   node scripts/localization-ai-eval.js [--limit N] [--style msa|gulf|mixed] [--intent X]
//        [--ids W01,T02] [--out DIR] [--run LABEL] [--no-english-baseline]
//        [--max-usd 8] [--concurrency 4] [--notes-file FILE]
//   node scripts/localization-ai-eval.js --render-only docs/localization/AI-MODE-EVAL.json [--notes-file FILE]
//
// The API key is read from the backend's .env (only the ANTHROPIC_API_KEY line is
// kept; nothing else from that file is loaded) and is never printed or written.
// Earlier runs are never overwritten or deleted: each run is also saved as
// AI-MODE-EVAL.run<N>.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { CASES } = require('../shared/localization/aiMode/evalSet');
const { STATIC_PROMPT } = require('../shared/localization/aiMode/prompt');
const { DEFAULTS } = require('../shared/localization/aiMode/agent');
const runner = require('../shared/localization/aiMode/evalRunner');
const report = require('../shared/localization/aiMode/evalReport');

const BACKEND_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(BACKEND_ROOT, '.env');
const DEFAULT_OUT = path.join(BACKEND_ROOT, 'docs', 'localization');
const BASENAME = 'AI-MODE-EVAL';

const USAGE = `Usage: node scripts/localization-ai-eval.js [options]
  --limit N              run an even sample of N cases
  --style S              msa | gulf | mixed
  --intent I             one intent (winback, inactive, top_loyalty, ...)
  --ids A,B              only these case ids
  --out DIR              output folder (default docs/localization)
  --run LABEL            label of this run (default: next number)
  --no-english-baseline  skip the English comparison run
  --max-usd N            stop when the estimated spend reaches N (default 8)
  --concurrency N        parallel prompts, 1-8 (default 4)
  --notes-file FILE      Markdown text (what changed in the prompt and why) to include
  --render-only JSON     rebuild the .md from a saved .json without calling Claude`;

// Only the key is taken from .env; the rest of the file is parsed and dropped.
function readApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!fs.existsSync(ENV_PATH)) return '';
  return String(dotenv.parse(fs.readFileSync(ENV_PATH)).ANTHROPIC_API_KEY || '');
}

function readText(file) {
  return file ? fs.readFileSync(path.resolve(file), 'utf8') : '';
}

function runFiles(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir).map((f) => ({ f, m: new RegExp(`^${BASENAME}\\.run(\\d+)\\.json$`).exec(f) })).filter((x) => x.m)
    .map((x) => ({ file: path.join(outDir, x.f), n: Number(x.m[1]) })).sort((a, b) => a.n - b.n);
}

function historyRow(label, summary) {
  const en = summary.english ? summary.english.overall.passRate : null;
  return {
    run: label, date: summary.meta.date, passRate: summary.overall.passRate, intentRate: summary.overall.intentRate,
    extractionRate: summary.overall.extractionRate, englishPassRate: en, unsafe: summary.safety.failures.length,
    spendUsd: summary.meta.spendUsd || 0,
  };
}

function loadHistory(outDir) {
  return runFiles(outDir).map(({ file, n }) => {
    try { return historyRow(`run ${n}`, JSON.parse(fs.readFileSync(file, 'utf8')).summary); } catch { return null; }
  }).filter(Boolean);
}

function writeOutputs(outDir, data, runNumber) {
  fs.mkdirSync(outDir, { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const md = report.renderMarkdown(data.summary);
  const history = path.join(outDir, `${BASENAME}.run${runNumber}.json`);
  if (fs.existsSync(history)) throw new Error(`${history} already exists; earlier runs are never overwritten`);
  fs.writeFileSync(history, json, 'utf8');
  fs.writeFileSync(path.join(outDir, `${BASENAME}.json`), json, 'utf8');
  fs.writeFileSync(path.join(outDir, `${BASENAME}.md`), md, 'utf8');
  return { history, json: path.join(outDir, `${BASENAME}.json`), md: path.join(outDir, `${BASENAME}.md`) };
}

function renderOnly(args) {
  const file = path.resolve(args.renderOnly);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { meta } = data.summary;
  if (args.notesFile) meta.notesMarkdown = readText(args.notesFile);
  // Rebuilt from the saved per-prompt records, so a newer report layout applies to an old run.
  data.summary = report.summarize({ ar: { records: data.records.ar }, en: data.records.en.length ? { records: data.records.en } : null, meta });
  const outDir = path.resolve(args.out || path.dirname(file));
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${BASENAME}.md`);
  fs.writeFileSync(target, report.renderMarkdown(data.summary), 'utf8');
  fs.writeFileSync(path.join(outDir, `${BASENAME}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`rendered ${target}`);
}

function progressLine({ done, total, record, language }) {
  const flag = record.score.pass ? 'ok  ' : record.score.safetyFailure ? 'RED ' : 'FAIL';
  console.log(`[${language}] ${String(done).padStart(3)}/${total} ${flag} ${record.id} ${(record.latencyMs / 1000).toFixed(1)}s`);
}

async function main(argv) {
  const args = runner.parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.renderOnly) { renderOnly(args); return 0; }

  const apiKey = readApiKey();
  if (!apiKey) { console.error('ANTHROPIC_API_KEY is not set (expected in the backend .env). Nothing was run.'); return 2; }
  const cases = runner.selectCases(CASES, args);
  if (!cases.length) { console.error('No cases match the filters.'); return 2; }

  const Anthropic = require('@anthropic-ai/sdk');
  const raw = new Anthropic({ apiKey, maxRetries: 0, timeout: 90 * 1000 });
  const tracker = runner.createUsageTracker({ maxUsd: args.maxUsd });
  const client = runner.createEvalClient(raw, { tracker });
  const model = DEFAULTS.model;
  console.log(`Evaluating ${cases.length} Arabic prompts${args.englishBaseline ? ` and their ${cases.length} English equivalents` : ''} on ${model} (cap USD ${args.maxUsd}, concurrency ${args.concurrency}).`);

  const common = { cases, client, concurrency: args.concurrency, onProgress: progressLine };
  const ar = await runner.runEval({ ...common, language: 'ar' });
  const en = args.englishBaseline && tracker.spentUsd() < args.maxUsd ? await runner.runEval({ ...common, language: 'en' }) : null;

  const outDir = path.resolve(args.out || DEFAULT_OUT);
  const previous = runFiles(outDir);
  const runNumber = args.runLabel && /^\d+$/.test(args.runLabel) ? Number(args.runLabel) : (previous.length ? previous[previous.length - 1].n + 1 : 1);
  const meta = {
    runLabel: `run ${runNumber}`,
    date: new Date().toISOString().slice(0, 10),
    model,
    cases: cases.length,
    filters: { limit: args.limit, style: args.style, intent: args.intent, ids: args.ids },
    englishBaseline: !!en,
    concurrency: args.concurrency,
    fixedNow: runner.FIXED_NOW.toISOString(),
    promptSha256: crypto.createHash('sha256').update(STATIC_PROMPT).digest('hex').slice(0, 16),
    spendUsd: Number(tracker.spentUsd().toFixed(4)),
    apiCalls: tracker.totals.calls,
    retries: tracker.totals.retries,
    notesMarkdown: readText(args.notesFile),
    history: [],
  };
  const summary = report.summarize({ ar, en, meta });
  meta.history = [...loadHistory(outDir), historyRow(meta.runLabel, summary)];
  const files = writeOutputs(outDir, { summary, records: { ar: ar.records, en: en ? en.records : [] } }, runNumber);

  const o = summary.overall;
  console.log(`\nIntent ${(o.intentRate * 100).toFixed(1)}%  Extraction ${o.extractionRate === null ? 'n/a' : `${(o.extractionRate * 100).toFixed(1)}%`}  Fully correct ${(o.passRate * 100).toFixed(1)}% (${o.passed}/${o.total})  Unsafe cases ${summary.safety.failures.length}  Executed actions ${summary.safety.executedActions}`);
  console.log(`Estimated spend USD ${meta.spendUsd} over ${meta.apiCalls} API calls (${meta.retries} retries). Target met: ${summary.meetsTarget ? 'yes' : 'no'}.`);
  console.log(`Wrote ${files.md}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('Evaluation failed:', String((err && err.message) || err).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]'));
    process.exitCode = 1;
  });
}

module.exports = { main, readApiKey, loadHistory, historyRow, runFiles };
