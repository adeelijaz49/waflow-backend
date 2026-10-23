'use strict';
// SANDBOX-ONLY launcher of the real backend for browser / end-to-end tests (task I1b). NEVER part of server.js.
//
//   node tests/onboarding/e2e/server.js            (run it from a SANDBOX copy of the backend, see below)
//
// Refuses to start unless MONGODB_URI is mongodb://127.0.0.1:27099/waflow_loc_test*, the outbound proxy is the dead
// harness proxy and the working directory is a sandbox copy (scratchpad/regress/...). Installs FakeGraph (axios
// adapter bridge), FakeStripe and FakeResend BEFORE requiring the real server.js, sets ONBOARDING_FLOW=on and the
// dummy environment the flow needs, listens on E2E_PORT (default 3100) and opens the CONTROL endpoint on
// E2E_CONTROL_PORT (default 3199): see control.js. Environment:
//   E2E_PORT, E2E_CONTROL_PORT   ports (127.0.0.1 control; the app listens on all interfaces like server.js)
//   E2E_POLICY                   ONBOARDING_LEGACY_SEND_POLICY: block (default) | platform_number
//   E2E_SEED_FILE                the JSON the seed script wrote (so the launcher can rebuild one fake per seeded WABA)
//   E2E_SCHEDULER=on             also start the onboarding scheduler (default: off, sweep through the control endpoint)
const { boot } = require('./boot');
const { createControlServer } = require('./control');

const DEFAULT_SEED = require('path').join(require('os').tmpdir(), 'waflow-onboarding-e2e', 'e2e-seed.json');

async function main() {
  const handle = await boot({ policy: process.env.E2E_POLICY || 'block' });
  const appPort = Number(process.env.E2E_PORT || 3100);
  const controlPort = Number(process.env.E2E_CONTROL_PORT || 3199);
  const control = createControlServer(handle, { appPort, seedFile: process.env.E2E_SEED_FILE || DEFAULT_SEED });
  const synced = await control.syncGraphFromDb().catch(() => []);

  await new Promise((resolve) => handle.app.listen(appPort, resolve));
  await new Promise((resolve) => control.server.listen(controlPort, '127.0.0.1', resolve));
  if (process.env.E2E_SCHEDULER === 'on') {
    try { require('../../../shared/onboarding/scheduler').startOnboardingScheduler(); } catch (e) { console.error('[e2e] scheduler not started:', e.message); }
  }
  console.log(`[e2e] sandbox backend on http://127.0.0.1:${appPort}, control on http://127.0.0.1:${controlPort}, db ${handle.db}, fakes ${synced.length}`);
  const stop = async () => { try { control.server.close(); await handle.stop(); } finally { process.exit(0); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((err) => { console.error('[e2e] launcher failed:', err && err.message); process.exit(1); });
}

module.exports = { main, DEFAULT_SEED };
