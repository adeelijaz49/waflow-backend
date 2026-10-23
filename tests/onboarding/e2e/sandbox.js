'use strict';
// SANDBOX-ONLY guards shared by the e2e launcher, the seed script and the contract dump (task I1b).
// Nothing in tests/onboarding/e2e is ever part of server.js: these files refuse to run unless the process is
// provably a throwaway sandbox (throwaway mongod + dead outbound proxy + a sandbox copy of the backend).

const DB_RE = /^mongodb:\/\/127\.0\.0\.1:27099\/waflow_loc_test[A-Za-z0-9_]*$/;
const DEAD_PROXY = 'http://127.0.0.1:9';

/** Throws unless MONGODB_URI is the throwaway database (127.0.0.1:27099/waflow_loc_test*). */
function assertThrowawayDb() {
  const uri = process.env.MONGODB_URI || '';
  if (!DB_RE.test(uri)) {
    throw new Error('refusing to run: MONGODB_URI is not the throwaway database (mongodb://127.0.0.1:27099/waflow_loc_test*)');
  }
}

/** Throws unless the outbound proxy is the dead one of the test harness (nothing can leave the machine). */
function assertDeadProxy() {
  const bad = ['HTTP_PROXY', 'HTTPS_PROXY'].filter((k) => process.env[k] !== DEAD_PROXY);
  if (bad.length || process.env.NODE_USE_ENV_PROXY !== '1') {
    throw new Error(`refusing to run: the outbound proxy is not the dead harness proxy (${DEAD_PROXY} with NODE_USE_ENV_PROXY=1)`);
  }
}

/** Throws unless the working directory is a sandbox copy of the backend (never the repo: its .env holds real credentials). */
function assertSandboxCwd(cwd = process.cwd()) {
  const p = String(cwd).split('\\').join('/');
  if (!p.includes('/scratchpad/regress/') && process.env.E2E_ALLOW_ANY_CWD !== 'sandbox-ok') {
    throw new Error('refusing to run: the working directory is not a sandbox copy of the backend (scratchpad/regress/...)');
  }
}

/** All three guards (DB, proxy, cwd). */
function assertSandbox() {
  assertThrowawayDb();
  assertDeadProxy();
  assertSandboxCwd();
}

/** Database name of the current MONGODB_URI (for the control endpoint). */
function dbName() {
  const m = /\/([^/?]+)(?:\?.*)?$/.exec(process.env.MONGODB_URI || '');
  return m ? m[1] : null;
}

module.exports = { assertThrowawayDb, assertDeadProxy, assertSandboxCwd, assertSandbox, dbName, DB_RE, DEAD_PROXY };
