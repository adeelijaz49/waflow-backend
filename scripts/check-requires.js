'use strict';
// Does everything the server needs at runtime actually exist in git?
//
//   node scripts/check-requires.js            (entry: server.js)
//   node scripts/check-requires.js server.js scripts/onboarding-admin.js
//
// A new file that is required by committed code but was never `git add`ed works on the machine it was written on and crashes the
// deployed server on start-up ("Cannot find module"). This follows every relative require('...') - also the lazy ones inside
// functions and require.resolve - from the entry files and fails (exit 1) when
//   * a required file is not in git (untracked or git-ignored): add it to the commit
//   * a require resolves to no file at all
// Run it after `git add` and before `git commit` / `git push`. Untracked files that nothing requires (tests, docs, scratch) are
// listed for information only: they are NOT a failure, just candidates for "not part of this commit".
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repo = path.resolve(__dirname, '..');
const entries = process.argv.slice(2).length ? process.argv.slice(2) : ['server.js'];

const git = (args) => cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
const norm = (p) => p.split(path.sep).join('/');
const tracked = new Set(git(['ls-files']).map(norm));
const untracked = new Set(git(['ls-files', '--others', '--exclude-standard']).map(norm));
const isFile = (rel) => { try { return fs.statSync(path.join(repo, rel)).isFile(); } catch (_) { return false; } };

const REQUIRE = /require(?:\.resolve)?\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
// A require( ... ) that is only mentioned in a comment ("mounted as require('./routes/x')") is not a dependency.
function inComment(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (/^\s*(\*|\/\*)/.test(prefix)) return true; // a line inside a /* ... */ block
  const code = prefix.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""'); // what is inside a string is not a comment marker
  return code.includes('//') || code.includes('/*');
}
function resolveFrom(fromRel, spec) {
  if (!spec.startsWith('.')) return null; // a package, not ours
  const base = norm(path.normalize(path.join(path.dirname(fromRel), spec)));
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.js`]) {
    if (isFile(candidate)) return { rel: candidate };
  }
  return { missing: true };
}

const seen = new Set();
const missing = [];
const queue = entries.map(norm);
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  if (!/\.c?js$/.test(rel)) continue;
  let text;
  try { text = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch (_) { missing.push({ from: '(entry file)', spec: rel }); continue; }
  for (const m of text.matchAll(REQUIRE)) {
    if (inComment(text, m.index)) continue;
    const found = resolveFrom(rel, m[2]);
    if (!found) continue;
    if (found.missing) missing.push({ from: rel, spec: m[2] });
    else queue.push(found.rel);
  }
}

// Files the server READS at run time without requiring them (a directory scan): the require walk cannot see them, so they are listed here.
const RUNTIME_READ = [{ dir: 'shared/localization/catalog/', ext: '.json' }]; // shared/localization/catalog.js loads every *.json in it
const readAtRuntime = [...untracked].filter((f) => RUNTIME_READ.some((r) => f.startsWith(r.dir) && f.endsWith(r.ext)));
for (const f of readAtRuntime) seen.add(f);

const notInGit = [...seen].filter((f) => !tracked.has(f) && isFile(f)).sort();
const unused = [...untracked].filter((f) => !seen.has(f)).sort();

console.log(`${seen.size} files are reachable from ${entries.join(', ')}.`);
if (notInGit.length) {
  console.log(`\nREQUIRED BUT NOT IN GIT (${notInGit.length}) - git add these, or the deployed server will not start:`);
  for (const f of notInGit) console.log(`  ${f}${untracked.has(f) ? '' : '   (git-ignored)'}`);
}
if (missing.length) {
  console.log(`\nREQUIRED BUT MISSING (${missing.length}) - no such file:`);
  for (const m of missing) console.log(`  ${m.from} -> ${m.spec}`);
}
if (unused.length) {
  console.log(`\nNot in git and not required by the server (${unused.length}) - tests, docs or scratch; commit only what belongs to the change:`);
  for (const f of unused) console.log(`  ${f}`);
}
if (notInGit.length || missing.length) process.exit(1);
console.log('\nOK: everything the server requires is in git.');
