'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
const BASE_URI = process.env.MONGODB_URI;
process.env.MONGODB_URI = `${BASE_URI}_e2etools`;
assertThrowawayDb();

// The sandbox tooling itself (task I1b): the guards, the seed script, the launcher with its control endpoint and the
// contract dump, each run as a REAL child process of this sandbox (never against anything but the throwaway mongod).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const sandbox = require('../e2e/sandbox');

jest.setTimeout(280000);

const SC = path.join(require('os').tmpdir(), 'waflow-onboarding-e2e', 'tools-test');
const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT = (n) => path.join(ROOT, 'tests', 'onboarding', 'e2e', n);
const childEnv = (db, extra) => ({ ...process.env, MONGODB_URI: `${BASE_URI}_${db}`, ...(extra || {}) });

function req(port, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: new http.Agent({ keepAlive: false }), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) { json = null; } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('sandbox guards', () => {
  const saved = { ...process.env };
  afterEach(() => { Object.keys(process.env).forEach((k) => { if (!(k in saved)) delete process.env[k]; }); Object.assign(process.env, saved); });

  test('the database guard accepts only mongodb://127.0.0.1:27099/waflow_loc_test*', () => {
    for (const bad of ['mongodb://127.0.0.1:27017/waflow_loc_test_x', 'mongodb://127.0.0.1:27099/waflow', 'mongodb://127.0.0.1:27099/waflow_prod_loc_test', 'mongodb+srv://u:p@cluster.example.test/waflow_loc_test', 'mongodb://localhost:27099/waflow_loc_test', '', 'mongodb://127.0.0.1:27099/waflow_loc_test?replicaSet=x']) {
      process.env.MONGODB_URI = bad;
      expect([bad, (() => { try { sandbox.assertThrowawayDb(); return 'allowed'; } catch (e) { return 'refused'; } })()]).toEqual([bad, 'refused']);
    }
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27099/waflow_loc_test_anything_1';
    expect(() => sandbox.assertThrowawayDb()).not.toThrow();
  });

  test('the proxy guard needs the dead harness proxy; the cwd guard needs a sandbox copy', () => {
    expect(() => sandbox.assertDeadProxy()).not.toThrow(); // runit.sh sets it
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
    expect(() => sandbox.assertDeadProxy()).toThrow(/dead harness proxy/);
    process.env.HTTPS_PROXY = sandbox.DEAD_PROXY;
    delete process.env.NODE_USE_ENV_PROXY;
    expect(() => sandbox.assertDeadProxy()).toThrow();
    expect(() => sandbox.assertSandboxCwd('C:/Users/someone/Repo/waflow-backend')).toThrow(/sandbox/);
    expect(() => sandbox.assertSandboxCwd('C:/x/scratchpad/regress/onb-I1b')).not.toThrow();
  });

  test('the launcher refuses to start on a non-throwaway database or without the dead proxy (no server, no listen)', () => {
    const run = (env) => spawnSync(process.execPath, [SCRIPT('server.js')], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
    const a = run({ MONGODB_URI: 'mongodb://127.0.0.1:27099/waflow', E2E_PORT: '3131', E2E_CONTROL_PORT: '3132' });
    expect(a.status).not.toBe(0);
    expect(`${a.stderr}${a.stdout}`).toMatch(/refusing to run/);
    const b = run({ HTTPS_PROXY: '', HTTP_PROXY: '', E2E_PORT: '3131', E2E_CONTROL_PORT: '3132' });
    expect(b.status).not.toBe(0);
    expect(`${b.stderr}${b.stdout}`).toMatch(/refusing to run/);
  });
});

describe('seed -> launcher + control endpoint -> contract dump, as real child processes', () => {
  const seedFile = path.join(SC, 'seed.json');
  let seeded;
  let launcher;
  let out = '';
  const APP = 3121;
  const CTL = 3122;
  const ctl = (m, p, body) => req(CTL, m, `/__control${p}`, { body });

  beforeAll(() => { fs.mkdirSync(SC, { recursive: true }); });
  afterAll(async () => {
    if (launcher && !launcher.killed) { launcher.kill('SIGTERM'); await sleep(500); if (!launcher.killed) launcher.kill('SIGKILL'); }
  });

  test('the seed fills an empty database with the 13 workspaces of DF section 9 and writes tokens + ids to a JSON file', () => {
    const r = spawnSync(process.execPath, [SCRIPT('seed.js')], { cwd: ROOT, env: childEnv('e2etools', { E2E_SEED_FILE: seedFile }), encoding: 'utf8', timeout: 200000 });
    expect([r.status, (r.stderr || '').slice(-400)]).toEqual([0, expect.any(String)]);
    seeded = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    const expected = { W0: false, W0b: false, W1: 'none', W2: 'pending', W3: 'active', W4: 'active', W5: 'active', W6: 'active', W7: 'past_due', W8: 'cancelled', W9: 'active', W10: 'active', W11: 'active' };
    expect(Object.keys(seeded.workspaces).sort()).toEqual(Object.keys(expected).sort());
    for (const [label, sub] of Object.entries(expected)) {
      const w = seeded.workspaces[label];
      const who = w.owner || w.member;
      expect([label, typeof who.token, who.token.split('.').length]).toEqual([label, 'string', 3]);
      expect([label, sub === false ? w.expect.enrolled : w.expect.subscription]).toEqual([label, sub]);
    }
    expect(seeded.workspaces.W10.member.role).toBe('member');
    expect(seeded.workspaces.W10.id).toBe(seeded.workspaces.W5.id);
    expect(seeded.workspaces.W0.expect).toMatchObject({ enrolled: false });
    expect(seeded.workspaces.W5.expect).toMatchObject({ locked: false, connection: 'needs_attention' });
    expect(seeded.workspaces.W6.expect).toMatchObject({ connection: 'reconnect_needed', sendingPaused: 'WHATSAPP_RECONNECT_REQUIRED' });
    expect(seeded.workspaces.W8.expect).toMatchObject({ view: 'done', subscription: 'cancelled' });
    expect(seeded.workspaces.W9.expect).toMatchObject({ view: 'done' });
    expect(Object.keys(seeded.graph).sort()).toEqual(['W5', 'W6', 'W8', 'W9']);
    // the file holds sandbox-only dummy-secret tokens and ids, never a Meta token, the app secret or a vault key
    const text = fs.readFileSync(seedFile, 'utf8');
    for (const s of [process.env.WA_TOKEN_ENCRYPTION_KEY || 'a1'.repeat(32), 'APP_SECRET_FIXTURE', 'EAAFXTmerchant', 'EAAPLATFORM', 'whsec_']) expect([s, text.includes(s)]).toEqual([s, false]);
  });

  test('the launcher rebuilds one fake WhatsApp account per seeded connection and serves the real API next to the control endpoint', async () => {
    launcher = spawn(process.execPath, [SCRIPT('server.js')], { cwd: ROOT, env: childEnv('e2etools', { E2E_PORT: String(APP), E2E_CONTROL_PORT: String(CTL), E2E_SEED_FILE: seedFile }), stdio: ['ignore', 'pipe', 'pipe'] });
    launcher.stdout.on('data', (c) => { out += c; });
    launcher.stderr.on('data', (c) => { out += c; });
    let health = null;
    for (let i = 0; i < 60 && !health; i += 1) { try { const r = await ctl('GET', '/health'); if (r.status === 200) health = r.json; } catch (_) { /* not up yet */ } await sleep(1000); }
    expect(health).toBeTruthy();
    expect(health).toMatchObject({ sandbox: true, flow: 'on', policy: 'block' });
    expect(health.db).toMatch(/^waflow_loc_test/);
    expect(health.graphFakes.sort()).toEqual(['W5', 'W6', 'W8', 'W9']);
    const ids = (await ctl('GET', '/graph/ids?fake=W5')).json;
    expect(ids.templates).toBeGreaterThanOrEqual(8);

    const tok = (l) => (seeded.workspaces[l].owner || seeded.workspaces[l].member).token;
    const st = await req(APP, 'GET', '/api/onboarding/state', { token: tok('W5') });
    expect(st.json).toMatchObject({ enrolled: true, subscription: { state: 'active' }, connection: { level: 'needs_attention' } });
    const member = await req(APP, 'GET', '/api/onboarding/state', { token: tok('W10') });
    expect(member.json.connection.numberFull).toBeUndefined();
    expect((await req(APP, 'GET', '/api/onboarding/state', { token: tok('W0') })).json).toEqual({ enrolled: false });

    // the rebuilt W5 fake accepts W5's decrypted merchant token: a refresh answers 200 and the call is logged against W5
    const rf = await req(APP, 'POST', '/api/onboarding/connection/refresh', { token: tok('W5'), body: {} });
    expect(rf.status).toBe(200);
    const calls = (await ctl('GET', '/calls?fake=W5')).json;
    expect(calls.graph.some((c) => c.name === 'getWaba' && c.tokenKind === 'merchant')).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/EAAFXT/);
  });

  test('control endpoint: graph scenarios, new target, env switch, stripe checkout + signed webhook, mail failure, sweep, mint, counters', async () => {
    const tok = (l) => (seeded.workspaces[l].owner || seeded.workspaces[l].member).token;
    expect((await ctl('GET', '/counters')).json).toMatchObject({ OnboardingState: expect.any(Number), WhatsAppConnection: expect.any(Number) });
    // Stripe: W1 pays through the fake checkout, the control endpoint completes it and delivers the SIGNED event
    const co = await req(APP, 'POST', '/api/onboarding/checkout', { token: tok('W1'), body: { planCode: 'basic' } });
    expect(co.status).toBe(200);
    const sessionId = co.json.url.split('/').pop();
    const done = await ctl('POST', '/stripe/complete-checkout', { sessionId, options: { businessName: 'W1 Shop', email: 'w1@example.test' } });
    expect(done.json.delivered).toMatchObject({ status: 200 });
    expect((await req(APP, 'GET', '/api/onboarding/state', { token: tok('W1') })).json).toMatchObject({ view: 'setup', subscription: { state: 'active', source: 'stripe' } });
    const bad = await req(APP, 'POST', '/stripe-billing-webhook', { body: { id: 'evt_unsigned' } });
    expect(bad.status).toBe(400);
    // payment fails then recovers, through the control endpoint
    const sub = done.json.session.subscription;
    expect((await ctl('POST', '/stripe/subscription', { subscriptionId: sub, status: 'past_due', invoice: 'payment_failed' })).json.status).toBe(200);
    expect((await req(APP, 'GET', '/api/onboarding/state', { token: tok('W1') })).json.subscription.state).toBe('past_due');
    expect((await ctl('POST', '/stripe/subscription', { subscriptionId: sub, status: 'active', invoice: 'paid' })).json.status).toBe(200);
    expect((await req(APP, 'GET', '/api/onboarding/state', { token: tok('W1') })).json.subscription.state).toBe('active');
    // per-scenario switches
    expect((await ctl('POST', '/env', { set: { ONBOARDING_LEGACY_SEND_POLICY: 'platform_number' } })).json.applied.ONBOARDING_LEGACY_SEND_POLICY).toBe('platform_number');
    expect((await req(APP, 'GET', '/api/onboarding/state', { token: tok('W9') })).json.sendingPaused).toBeNull();
    await ctl('POST', '/env', { set: { ONBOARDING_LEGACY_SEND_POLICY: 'block' } });
    expect((await ctl('POST', '/env', { set: { AUTH_JWT_SECRET: 'x' } })).status).toBe(400); // only whitelisted switches
    // a fresh target fake for a new connect + a graph scenario
    const target = (await ctl('POST', '/graph/new-target', { key: 'browser-1' })).json;
    expect(target.wabaId).toMatch(/^\d+$/);
    expect((await ctl('POST', '/graph', { fake: 'browser-1', op: 'scenario', name: 'codeExpired' })).json.ok).toBe(true);
    expect((await ctl('POST', '/graph', { fake: 'W5', op: 'method', name: 'setTier', args: ['TIER_1K'] })).json.ok).toBe(true);
    expect((await ctl('POST', '/graph', { fake: 'W5', op: 'method', name: 'constructor' })).status).toBe(400);
    // a template status change through a SIGNED Meta webhook (the real path), a bad signature is refused
    const tpls = (await ctl('GET', '/graph/ids?fake=W5')).json;
    expect(tpls.wabaId).toMatch(/^[0-9]+$/);
    const payload = { object: 'whatsapp_business_account', entry: [{ id: tpls.wabaId, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '966558000009', event: 'ONBOARDING', current_limit: 'TIER_1K' } }] }] };
    expect((await ctl('POST', '/meta-webhook', { payload, signature: 'valid' })).json.status).toBe(200);
    expect((await ctl('POST', '/meta-webhook', { payload, signature: 'invalid' })).json.status).toBe(403);
    // e-mail failure injection, the sweep and a forged-role token
    expect((await ctl('POST', '/mail', { failNext: 1 })).json.ok).toBe(true);
    const sw = (await ctl('POST', '/sweep', {})).json;
    expect(sw).toMatchObject({ skipped: false });
    const minted = (await ctl('POST', '/mint', { userId: seeded.workspaces.W10.member.id, workspaceId: seeded.workspaces.W5.id, role: 'owner' })).json.token;
    const forged = await req(APP, 'POST', '/api/onboarding/connection/disconnect/request', { token: minted, body: {} });
    expect([forged.status, forged.json.code]).toEqual([403, 'OWNER_ONLY']);
    const logs = (await ctl('GET', '/calls')).json;
    expect(logs.platform).toEqual([]); // nothing ever used the platform number
    expect((await ctl('POST', '/reset-logs', {})).json.ok).toBe(true);
    expect((await ctl('GET', '/nonsense')).status).toBe(404);
    launcher.kill('SIGTERM');
    await sleep(800);
    expect(out).not.toMatch(/EAAFXT|APP_SECRET_FIXTURE/);
  });

  test('the contract dump writes every GET and the key POST answers per workspace and its own secret scan finds nothing', () => {
    const dir = path.join(SC, 'contract');
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(process.execPath, [SCRIPT('dump-contract.js')], { cwd: ROOT, env: childEnv('e2edump', { E2E_CONTRACT_DIR: dir }), encoding: 'utf8', timeout: 240000 });
    expect([r.status, (r.stderr || '').slice(-300)]).toEqual([0, expect.any(String)]);
    const index = JSON.parse(fs.readFileSync(path.join(dir, '_index.json'), 'utf8'));
    expect(index.count).toBeGreaterThanOrEqual(150);
    const files = new Set(index.files.map((f) => f.file));
    for (const wsLabel of ['W0', 'W0b', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11']) {
      for (const ep of ['state', 'connection', 'approvals', 'templates', 'first-promotion', 'notifications', 'help-context', 'connect-config']) expect([wsLabel, ep, files.has(`${wsLabel}-${ep}.json`)]).toEqual([wsLabel, ep, true]);
    }
    for (const f of ['W3-number-path-unused.json', 'W3-connect-event-cancel.json', 'W3-connect-event-error.json', 'W3-connect-event-no-facebook.json', 'W3-connect-complete-partial.json', 'W3-connect-resume.json', 'W1-checkout.json', 'W5-test-message.json', 'W1-billing-refresh.json']) {
      expect([f, files.has(f)]).toEqual([f, true]);
    }
    // an independent scan: no JWT, vault envelope, Meta token, Stripe secret, app secret, platform token, key or code in any file
    const { scanText } = require('../e2e/dump-contract');
    const findings = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      findings.push(...scanText(f, text, ['APP_SECRET_FIXTURE_0123456789abcdef', 'a1'.repeat(32), 'EAAPLATFORMdummyTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz', 'onb-e2e-sandbox-jwt-secret-not-real']));
      if (f !== '_index.json') expect([f, /"(token|accessToken|access_token|tokenEncrypted|pinEncrypted|pin|code|authorization)"\s*:\s*"[^"]{6,}"/.test(text.replace(/"code":\s*"[A-Z][A-Z0-9_]+"/g, ''))]).toEqual([f, false]);
    }
    expect(findings).toEqual([]);
    // the full business number appears only under connection.numberFull of an OWNER's state
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== '_index.json')) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/"numberFull":\s*"[^"]*"/g, '');
      expect([f, /\+966 55 9\d\d \d{4}/.test(text)]).toEqual([f, false]);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'W10-state.json'), 'utf8')).connection.numberFull).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'W0-state.json'), 'utf8'))).toEqual({ enrolled: false });
  });
});
