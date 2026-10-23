'use strict';
const express = require('express');
const request = require('supertest');
const starter = require('../../../shared/onboarding/starterTemplates');
const metaConstraints = require('../../../shared/localization/metaConstraints');
const { OnbError } = require('../../../shared/onboarding/errors');
const { WS, WS2, MERCHANT_TOKEN, PLATFORM_TOKEN, makeWorld, seedTemplate, flat, captureLogs } = require('./_b1eKit');

const SAVED = {};
const ENV = ['ONBOARDING_TEMPLATE_CEILING', 'ONBOARDING_STARTER_TEMPLATES', 'WA_TOKEN', 'WA_PHONE_ID'];
beforeEach(() => { for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; } process.env.WA_TOKEN = PLATFORM_TOKEN; });
afterEach(() => { for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

const KEYS = ['welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation', 'setup_test'];
const row = (w, key, language) => w.Template.rows.find((r) => r.key === key && r.language === language);
const submits = (w) => w.client.calls.filter((c) => c.name === 'submit');
const notified = (w) => w.notify.mock.calls.map((c) => c[0]);
/** the per-template notifications (in the app; only a rejection also sends an e-mail) and the two coalesced milestone notifications */
const perTemplate = (w) => notified(w).filter((a) => /^template:/.test(a.dedupeKey));
const milestones = (w) => notified(w).filter((a) => /^templates:/.test(a.dedupeKey));

describe('STARTER_KEYS', () => {
  test('the 7 locked D9 keys by default, read from config on every access', () => {
    expect(starter.STARTER_KEYS).toEqual(['welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation']);
    process.env.ONBOARDING_STARTER_TEMPLATES = 'comeback,points_balance';
    expect(starter.STARTER_KEYS).toEqual(['comeback', 'points_balance']);
  });
  test('every exported name of INTERFACES 2.16 is present, plus pollStatuses', () => {
    for (const n of ['seedStarterTemplates', 'listStatuses', 'submitQueued', 'resubmit', 'applyTemplateStatusUpdate', 'pollStatuses']) expect(typeof starter[n]).toBe('function');
  });
});

describe('seedStarterTemplates (queues, NO Meta call)', () => {
  test('English-only merchant: 8 keys x 2 languages; English queued, Arabic blocked (legal for welcome_optin)', async () => {
    const w = makeWorld();
    const r = await starter.seedStarterTemplates(WS, w.deps);
    expect(r).toEqual({ created: 16, existing: 0, total: 16 });
    expect(w.Template.rows).toHaveLength(16);
    for (const k of KEYS) {
      expect(row(w, k, 'en')).toMatchObject({ revision: 1, attempts: 0, blockedReason: null });
      expect(row(w, k, 'ar').blockedReason).toBe(k === 'welcome_optin' ? 'legal' : 'arabic_not_reviewed');
    }
    expect(row(w, 'setup_test', 'en')).toMatchObject({ source: 'setup_test', category: 'UTILITY' });
    expect(row(w, 'comeback', 'en')).toMatchObject({ source: 'library', category: 'MARKETING' });
    expect(row(w, 'order_confirmation', 'en').category).toBe('UTILITY');
    expect(w.client.calls).toHaveLength(0);
    expect(w.vault.decrypt).not.toHaveBeenCalled();
  });

  test('Arabic merchant: every Arabic variant queued except the legal-sensitive welcome_optin', async () => {
    const w = makeWorld({ languages: ['en', 'ar'] });
    await starter.seedStarterTemplates(WS, w.deps);
    for (const k of KEYS) {
      expect(row(w, k, 'en').blockedReason).toBeNull();
      expect(row(w, k, 'ar').blockedReason).toBe(k === 'welcome_optin' ? 'legal' : null);
    }
  });

  test('welcome_optin is never queued in Arabic, whatever the merchant chose', async () => {
    const w = makeWorld({ languages: ['ar'] });
    await starter.seedStarterTemplates(WS, w.deps);
    expect(row(w, 'welcome_optin', 'ar').blockedReason).toBe('legal');
    const q = await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    expect(q.submitted).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    expect(submits(w).some((c) => /welcome_optin_ar/.test(c.payload.name))).toBe(false);
  });

  test('idempotent; adding Arabic later unblocks only the not-yet-submitted non-legal Arabic rows', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const again = await starter.seedStarterTemplates(WS, w.deps);
    expect(again).toEqual({ created: 0, existing: 16, total: 16 });
    expect(w.Template.rows).toHaveLength(16);
    w.State.rows[0].business.languages = ['en', 'ar'];
    await starter.seedStarterTemplates(WS, w.deps);
    expect(row(w, 'comeback', 'ar').blockedReason).toBeNull();
    expect(row(w, 'setup_test', 'ar').blockedReason).toBeNull();
    expect(row(w, 'welcome_optin', 'ar').blockedReason).toBe('legal');
    // a submitted row is never touched by a re-seed
    const submitted = seedTemplate(w, { key: 'zz', language: 'ar', metaTemplateId: '5', blockedReason: 'arabic_not_reviewed' });
    await starter.seedStarterTemplates(WS, w.deps);
    expect(submitted.blockedReason).toBe('arabic_not_reviewed');
  });

  test('a variant that fails validateVariant is blocked "invalid" and never submitted', async () => {
    const w = makeWorld();
    const good = require('../../../shared/localization/templateLibrary');
    const library = {
      listLibraryStrings: good.listLibraryStrings,
      getLibraryEntry: (key) => {
        const e = good.getLibraryEntry(key);
        if (e && key === 'comeback') e.variants.en.body = '{name} come back soon'; // starts with a variable: Meta rejects
        return e;
      },
    };
    await starter.seedStarterTemplates(WS, { ...w.deps, library });
    expect(row(w, 'comeback', 'en').blockedReason).toBe('invalid');
    expect(row(w, 'promotion_weekend', 'en').blockedReason).toBeNull();
    for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: WS, max: 5 }, { ...w.deps, library });
    expect(submits(w).some((c) => /comeback_en/.test(c.payload.name))).toBe(false);
  });

  test('unknown keys from the env are skipped', async () => {
    const w = makeWorld();
    process.env.ONBOARDING_STARTER_TEMPLATES = 'comeback,no_such_key';
    const r = await starter.seedStarterTemplates(WS, w.deps);
    expect(r.total).toBe(4); // comeback + setup_test, two languages each
    expect(w.Template.rows.map((x) => x.key).sort()).toEqual(['comeback', 'comeback', 'setup_test', 'setup_test']);
  });

  test('tenant isolation: another workspace has its own rows', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.seedStarterTemplates(WS2, w.deps);
    expect(w.Template.rows).toHaveLength(32);
    expect(w.Template.rows.filter((r) => String(r.workspaceId) === WS2)).toHaveLength(16);
  });
});

describe('submitQueued: payloads, claim, caps', () => {
  async function seeded(opts) {
    const w = makeWorld(opts);
    await starter.seedStarterTemplates(WS, w.deps);
    return w;
  }

  test('payloads: wf_<ws6>_<key>_<lang>_v1, allow_category_change, en/ar codes, validateVariant, MERCHANT token and WABA id', async () => {
    const w = await seeded({ languages: ['en', 'ar'] });
    let total = 0;
    for (let i = 0; i < 4; i += 1) { const r = await starter.submitQueued({ workspaceId: WS }, w.deps); total += r.submitted; }
    expect(total).toBe(15); // 8 en + 7 ar (welcome_optin ar is blocked)
    const calls = submits(w);
    expect(calls).toHaveLength(15);
    for (const c of calls) {
      expect(c.token).toBe(MERCHANT_TOKEN);
      expect(c.wabaId).toBe('W1');
      expect(c.payload.allow_category_change).toBe(true);
      expect(['en', 'ar']).toContain(c.payload.language);
      expect(c.payload.name).toMatch(/^wf_439011_[a-z0-9_]+_(en|ar)_v1$/);
      expect(['MARKETING', 'UTILITY']).toContain(c.payload.category);
      expect(c.payload.components.find((x) => x.type === 'BODY')).toBeTruthy();
    }
    expect(calls.map((c) => c.payload.language)).not.toContain('ar_SA');
    expect(calls.some((c) => /welcome_optin_ar/.test(c.payload.name))).toBe(false);
    // Meta example values exist for every body variable; MARKETING carries the opt-out button
    const promo = calls.find((c) => c.payload.name === 'wf_439011_promotion_weekend_en_v1').payload;
    expect(promo.components.find((x) => x.type === 'BODY').example.body_text[0].length).toBe(3);
    expect(promo.components.find((x) => x.type === 'BUTTONS').buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Opt Out' }]);
    // the platform token never reaches the client
    expect(flat(w.client.calls)).not.toContain(PLATFORM_TOKEN);
    // the vault is asked with the workspace-bound purpose
    expect(w.vault.decrypt).toHaveBeenCalledWith(expect.any(String), { workspaceId: WS, purpose: 'token' });
  });

  test('every library payload validates with metaConstraints.validateVariant', async () => {
    const w = await seeded({ languages: ['en', 'ar'] });
    for (const key of KEYS) {
      const spec = starter.getSpec(key);
      for (const lang of ['en', 'ar']) {
        if (key === 'welcome_optin' && lang === 'ar') continue;
        const check = metaConstraints.validateVariant(spec.variantFor(lang), { category: spec.category });
        expect({ key, lang, errors: check.errors }).toEqual({ key, lang, errors: [] });
      }
    }
    expect(w.client.calls).toHaveLength(0);
  });

  test('at most 5 per call (max honoured and clamped), English first, test template first of all', async () => {
    const w = await seeded();
    const a = await starter.submitQueued({ workspaceId: WS, max: 3 }, w.deps);
    expect(a).toMatchObject({ submitted: 3, failed: 0, limitReached: false, aborted: null });
    expect(submits(w).map((c) => c.payload.name)).toEqual([
      'wf_439011_setup_test_en_v1', 'wf_439011_welcome_optin_en_v1', 'wf_439011_promotion_weekend_en_v1',
    ]);
    const b = await starter.submitQueued({ workspaceId: WS, max: 99 }, w.deps);
    expect(b.submitted).toBe(5);
    const c = await starter.submitQueued({ workspaceId: WS }, w.deps);
    expect(c.submitted).toBe(0); // 8 English rows are all done; the Arabic ones are blocked
    expect(submits(w)).toHaveLength(8);
  });

  test('claim + result bookkeeping on the row', async () => {
    const w = await seeded();
    await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    const r = row(w, 'setup_test', 'en');
    expect(r).toMatchObject({ attempts: 1, metaTemplateName: 'wf_439011_setup_test_en_v1', metaStatus: 'PENDING', metaStatusRaw: 'PENDING', category: 'UTILITY', lastErrorCode: null });
    expect(r.metaTemplateId).toMatch(/^\d+$/);
    expect(r.submitClaimedAt).toBeNull();
    expect(r.submittedAt).toEqual(w.clock.now());
    // a submitted row is not submitted again
    await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(submits(w).filter((c) => /setup_test_en/.test(c.payload.name))).toHaveLength(1);
  });

  test('the stored category follows what Meta returns (UTILITY submitted, MARKETING returned)', async () => {
    const w = await seeded();
    w.client.submitTemplate.mockImplementationOnce(async (token, waba, payload) => ({ id: '77', status: 'PENDING', category: 'MARKETING' }));
    await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(row(w, 'setup_test', 'en').category).toBe('MARKETING');
  });

  test('two simultaneous calls never submit the same row twice (atomic claim)', async () => {
    const w = await seeded();
    const [a, b] = await Promise.all([starter.submitQueued({ workspaceId: WS }, w.deps), starter.submitQueued({ workspaceId: WS }, w.deps)]);
    const names = submits(w).map((c) => c.payload.name);
    expect(new Set(names).size).toBe(names.length);
    expect(a.submitted + b.submitted).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(10);
  });

  test('a stale claim (crashed run) is taken over; a fresh claim is respected', async () => {
    const w = await seeded();
    const fresh = row(w, 'setup_test', 'en');
    fresh.submitClaimedAt = new Date(w.clock.now().getTime() - 60 * 1000);
    fresh.attempts = 1;
    const r1 = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(r1.submitted).toBe(1);
    expect(submits(w)[0].payload.name).toBe('wf_439011_welcome_optin_en_v1'); // setup_test skipped: claimed a minute ago
    fresh.submitClaimedAt = new Date(w.clock.now().getTime() - 30 * 60 * 1000);
    const r2 = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(r2.submitted).toBe(1);
    expect(submits(w)[1].payload.name).toBe('wf_439011_setup_test_en_v1');
  });

  test('nothing queued: no connection needed, no Graph call', async () => {
    const w = makeWorld({ connStatus: null });
    const r = await starter.submitQueued({ workspaceId: WS }, w.deps);
    expect(r).toMatchObject({ submitted: 0, remaining: 0 });
  });

  test('tenant isolation: another workspace\'s rows are not submitted', async () => {
    const w = await seeded();
    await starter.seedStarterTemplates(WS2, w.deps);
    await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    expect(w.Template.rows.filter((r) => String(r.workspaceId) === WS2 && r.metaTemplateId)).toHaveLength(0);
  });
});

describe('submitQueued: connection requirements', () => {
  test.each([
    ['no connection row', { connStatus: null }, 'WHATSAPP_NOT_CONNECTED'],
    ['not connected yet', { connStatus: 'connecting' }, 'WHATSAPP_NOT_CONNECTED'],
    ['needs reconnect', { needsReconnect: true }, 'WHATSAPP_RECONNECT_REQUIRED'],
    ['token cannot be decrypted', { vaultFails: true }, 'WHATSAPP_RECONNECT_REQUIRED'],
  ])('%s -> %s, rows stay queued, no Graph call', async (label, opts, code) => {
    const w = makeWorld(opts);
    await starter.seedStarterTemplates(WS, w.deps);
    await expect(starter.submitQueued({ workspaceId: WS }, w.deps)).rejects.toMatchObject({ code });
    expect(w.client.calls).toHaveLength(0);
    expect(w.Template.rows.every((r) => !r.metaTemplateId && !r.submitClaimedAt)).toBe(true);
  });

  test('encryption not configured -> ENCRYPTION_NOT_CONFIGURED', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.vault.decrypt.mockImplementation(() => { const e = new Error('x'); e.code = 'ENCRYPTION_NOT_CONFIGURED'; throw e; });
    await expect(starter.submitQueued({ workspaceId: WS }, w.deps)).rejects.toMatchObject({ code: 'ENCRYPTION_NOT_CONFIGURED', status: 503 });
  });

  test('a WABA-only connection (no phone yet) can already submit templates', async () => {
    const w = makeWorld({ connStatus: 'waba_only' });
    await starter.seedStarterTemplates(WS, w.deps);
    const r = await starter.submitQueued({ workspaceId: WS, max: 2 }, w.deps);
    expect(r.submitted).toBe(2);
  });
});

describe('duplicate-name adoption (100 / 2388024)', () => {
  const dupError = (shape) => {
    if (shape === 'graph') { const e = new Error('dup'); e.code = 100; e.subcode = 2388024; return e; }
    if (shape === 'metaApi') { const e = new Error('dup'); e.name = 'MetaApiError'; e.metaError = { code: 100, subcode: 2388024, message: 'dup' }; return e; }
    if (shape === 'kind') { const e = new Error('dup'); e.kind = 'duplicate_template'; return e; }
    const e = new Error('dup'); e.response = { data: { error: { code: 100, error_subcode: 2388024 } } }; return e;
  };

  test.each(['graph', 'metaApi', 'kind', 'axios'])('%s-shaped error: the existing template is listed by name and adopted', async (shape) => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.client.remote.push({ id: '555', name: 'wf_439011_setup_test_en_v1', language: 'en', status: 'APPROVED', category: 'UTILITY', wabaId: 'W1' });
    w.client.failNext.push({ name: 'submit', err: dupError(shape) });
    const r = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(r).toMatchObject({ submitted: 0, adopted: 1, failed: 0 });
    expect(row(w, 'setup_test', 'en')).toMatchObject({ metaTemplateId: '555', metaStatus: 'APPROVED', metaTemplateName: 'wf_439011_setup_test_en_v1', submitClaimedAt: null });
    const list = w.client.calls.find((c) => c.name === 'list');
    expect(list.token).toBe(MERCHANT_TOKEN);
    expect(list.query.name).toBe('wf_439011_setup_test_en_v1');
  });

  test('an adopted template that is already APPROVED is tracked (the setup test template does not notify)', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.client.remote.push({ id: '556', name: 'wf_439011_welcome_optin_en_v1', language: 'en', status: 'APPROVED', category: 'MARKETING', wabaId: 'W1' });
    w.client.remote.push({ id: '555', name: 'wf_439011_setup_test_en_v1', language: 'en', status: 'APPROVED', category: 'UTILITY', wabaId: 'W1' });
    // submitTemplate itself reports the duplicate (the fake client does), so both rows are adopted
    const r = await starter.submitQueued({ workspaceId: WS, max: 2 }, w.deps);
    expect(r.adopted).toBe(2);
    expect(perTemplate(w)).toHaveLength(1);
    expect(perTemplate(w)[0]).toMatchObject({ kind: 'template_approved', dedupeKey: 'template:556:APPROVED', workspaceId: WS, email: false });
    // the approved library template is the first milestone; the approved setup test template counts for nothing
    expect(milestones(w)).toEqual([expect.objectContaining({ kind: 'template_approved', dedupeKey: 'templates:first_approved', params: { count: 1, total: 7 }, email: true })]);
  });

  test('a duplicate that cannot be found by name stays queued with a clear code and is retried later', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.client.failNext.push({ name: 'submit', err: dupError('graph') });
    const r = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(r).toMatchObject({ adopted: 0, failed: 1 });
    expect(row(w, 'setup_test', 'en')).toMatchObject({ lastErrorCode: 'TEMPLATE_DUPLICATE_UNRESOLVED', attempts: 1, submitClaimedAt: null });
    expect(row(w, 'setup_test', 'en').metaTemplateId).toBeUndefined();
    const r2 = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(r2.submitted).toBe(1);
  });
});

describe('ceiling (TEMPLATE_LIMIT_REACHED)', () => {
  test('stops at config.templateCeiling() and then refuses with 409', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    process.env.ONBOARDING_TEMPLATE_CEILING = '3';
    const a = await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    expect(a).toMatchObject({ submitted: 3, limitReached: true });
    expect(submits(w)).toHaveLength(3);
    await expect(starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps)).rejects.toMatchObject({ code: 'TEMPLATE_LIMIT_REACHED', status: 409 });
    expect(submits(w)).toHaveLength(3);
  });

  test('the default ceiling is 90', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    for (let i = 0; i < 89; i += 1) seedTemplate(w, { key: `x${i}`, language: 'en', metaTemplateId: String(i) });
    await expect(starter.submitQueued({ workspaceId: WS }, w.deps)).resolves.toMatchObject({ submitted: 1, limitReached: true });
    await expect(starter.submitQueued({ workspaceId: WS }, w.deps)).rejects.toMatchObject({ code: 'TEMPLATE_LIMIT_REACHED' });
  });
});

describe('Graph failures', () => {
  const net = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

  test('a network failure releases the claim, records a safe code, and is retried; attempts are capped', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.client.failNext.push({ name: 'submit', err: net(), times: 1 });
    const a = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(a).toMatchObject({ submitted: 0, failed: 1 });
    expect(row(w, 'setup_test', 'en')).toMatchObject({ lastErrorCode: 'META_UNREACHABLE', attempts: 1, submitClaimedAt: null });
    expect(row(w, 'setup_test', 'en').metaTemplateId).toBeUndefined();
    const b = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(b.submitted).toBe(1);
    expect(row(w, 'setup_test', 'en')).toMatchObject({ attempts: 2, lastErrorCode: null });
    // a permanently failing row stops being picked after 5 attempts
    const bad = row(w, 'welcome_optin', 'en');
    bad.attempts = 5;
    const c = await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps);
    expect(submits(w).filter((x) => /welcome_optin_en/.test(x.payload.name))).toHaveLength(0);
    expect(c.submitted).toBe(1); // the next row went instead
  });

  test('an unclassified Graph error stores only a code, never the message (which may carry a token)', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const err = Object.assign(new Error(`oops ${MERCHANT_TOKEN}`), { code: 100 });
    w.client.failNext.push({ name: 'submit', err });
    const lines = await captureLogs(async () => { await starter.submitQueued({ workspaceId: WS, max: 1 }, w.deps); });
    expect(row(w, 'setup_test', 'en').lastErrorCode).toBe('META_100');
    expect(flat(w.Template.rows) + lines.join('\n')).not.toContain(MERCHANT_TOKEN);
  });

  test('a revoked token (reconnect kind) flips the connection once and aborts the run', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const err = Object.assign(new Error('Session has expired'), { code: 190, subcode: 463, kind: 'reconnect' });
    w.client.failNext.push({ name: 'submit', err, times: 5 });
    const r = await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    expect(r).toMatchObject({ aborted: 'reconnect', failed: 1, submitted: 0 });
    expect(submits(w)).toHaveLength(1);
    expect(w.connect.reportGraphError).toHaveBeenCalledTimes(1);
    expect(w.connect.reportGraphError.mock.calls[0][0]).toBe(WS);
    expect(row(w, 'setup_test', 'en').submitClaimedAt).toBeNull();
  });

  test('kind comes from metaErrors.classify when the error carries none, and from a local table as a last resort', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const metaErrors = { classify: jest.fn(() => ({ kind: 'reconnect' })) };
    w.client.failNext.push({ name: 'submit', err: Object.assign(new Error('x'), { code: 999 }) });
    const r = await starter.submitQueued({ workspaceId: WS, max: 1 }, { ...w.deps, metaErrors });
    expect(r.aborted).toBe('reconnect');
    // metaErrors still a stub (throws): the local table maps 190 to reconnect
    const w2 = makeWorld();
    await starter.seedStarterTemplates(WS, w2.deps);
    const stub = { classify: () => { throw Object.assign(new Error('nope'), { code: 'NOT_IMPLEMENTED' }); } };
    w2.client.failNext.push({ name: 'submit', err: Object.assign(new Error('x'), { code: 190 }) });
    const r2 = await starter.submitQueued({ workspaceId: WS, max: 1 }, { ...w2.deps, metaErrors: stub });
    expect(r2.aborted).toBe('reconnect');
  });
});

describe('listStatuses', () => {
  test('rows: ui status, category, titles, reason keys; ordered like the starter set', async () => {
    const w = makeWorld({ languages: ['en', 'ar'] });
    await starter.seedStarterTemplates(WS, w.deps);
    Object.assign(row(w, 'welcome_optin', 'en'), { metaTemplateId: '1', metaStatus: 'APPROVED', category: 'MARKETING' });
    Object.assign(row(w, 'comeback', 'en'), { metaTemplateId: '2', metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT', rejectionRecommendation: 'Remove the emoji' });
    Object.assign(row(w, 'points_balance', 'en'), { metaTemplateId: '3', metaStatus: 'PENDING' });
    Object.assign(row(w, 'promotion_weekend', 'en'), { metaTemplateId: '4', metaStatus: 'PAUSED' });
    Object.assign(row(w, 'promotion_new_arrival', 'en'), { metaTemplateId: '5', metaStatus: 'DELETED' });
    const rows = await starter.listStatuses(WS, w.deps);
    expect(rows).toHaveLength(16);
    expect(rows[0]).toMatchObject({ key: 'welcome_optin', language: 'en', status: 'approved', category: 'MARKETING', reasonKey: null, rejectedReason: null, canResubmit: false });
    expect(rows[0].title).toEqual({ en: 'Welcome and opt-in', ar: expect.any(String) });
    const by = (k, l) => rows.find((r) => r.key === k && r.language === l);
    expect(by('welcome_optin', 'ar')).toMatchObject({ status: 'blocked', blockedReason: 'legal', reasonKey: 'onboarding.approvals.templates.arBlocked' });
    expect(by('comeback', 'en')).toMatchObject({ status: 'rejected', rejectedReason: 'INVALID_FORMAT', recommendation: 'Remove the emoji', reasonKey: 'onboarding.approvals.templates.rejected', canResubmit: true });
    expect(by('points_balance', 'en').status).toBe('pending');
    expect(by('promotion_weekend', 'en').status).toBe('paused');
    expect(by('promotion_new_arrival', 'en').status).toBe('unavailable');
    expect(by('order_confirmation', 'en')).toMatchObject({ status: 'queued', reasonKey: 'onboarding.approvals.templates.queued' });
    expect(by('setup_test', 'en').title.en).toBe('Setup test message');
    expect(rows.map((r) => `${r.key}/${r.language}`).slice(0, 4)).toEqual(['welcome_optin/en', 'welcome_optin/ar', 'promotion_weekend/en', 'promotion_weekend/ar']);
    expect(rows[rows.length - 2].key).toBe('setup_test');
    // never the Meta name or id
    expect(flat(rows)).not.toMatch(/wf_[0-9a-f]{6}_/);
  });

  test('capacity counters and the Arabic flag', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    Object.assign(row(w, 'comeback', 'en'), { metaTemplateId: '2', metaStatus: 'APPROVED' });
    const cap = await starter.getCapacity(WS, w.deps);
    expect(cap).toMatchObject({ ceiling: 90, metaLimit: 250, used: 1, remaining: 89, total: 16, approved: 1, pending: 0, rejected: 0, queued: 7, blocked: 8, arabicRequested: false });
  });

  test('tenant isolation', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    expect(await starter.listStatuses(WS2, w.deps)).toEqual([]);
  });
});

describe('applyTemplateStatusUpdate (webhook)', () => {
  async function submitted(opts) {
    const w = makeWorld(opts);
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    return w;
  }
  const idOf = (w, key, lang = 'en') => row(w, key, lang).metaTemplateId;

  test('APPROVED by id: stored, notified once (key has the id and status), idempotent', async () => {
    const w = await submitted();
    const id = idOf(w, 'promotion_weekend');
    const a = await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: Number(id), statusRaw: 'APPROVED' }, w.deps);
    expect(a).toEqual({ updated: true, changed: true, status: 'APPROVED' });
    expect(row(w, 'promotion_weekend', 'en')).toMatchObject({ metaStatus: 'APPROVED', metaStatusRaw: 'APPROVED', rejectedReason: null });
    expect(perTemplate(w)).toHaveLength(1);
    expect(perTemplate(w)[0]).toMatchObject({
      workspaceId: WS, kind: 'template_approved', dedupeKey: `template:${id}:APPROVED`, severity: 'success',
      params: { template: 'Weekend offer', language: 'en' }, email: false, // an approval is an in-app notification; the e-mail is the coalesced milestone
    });
    expect(milestones(w)).toHaveLength(1);
    const callsAfterFirst = w.notify.mock.calls.length;
    const b = await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: 'APPROVED' }, w.deps);
    expect(b).toMatchObject({ updated: true, changed: false });
    expect(w.notify).toHaveBeenCalledTimes(callsAfterFirst); // a repeat delivery notifies nothing at all
    const tracked = w.track.mock.calls.filter((c) => c[1].code === 'TEMPLATE_APPROVED');
    expect(tracked).toHaveLength(1);
  });

  test('REJECTED by name with the webhook language form en-US: reason + recommendation stored, notified', async () => {
    const w = await submitted();
    const name = row(w, 'comeback', 'en').metaTemplateName;
    const r = await starter.applyTemplateStatusUpdate({ workspaceId: WS, name, language: 'en-US', statusRaw: 'REJECTED', reason: 'INVALID_FORMAT', recommendation: 'Remove the emoji from the first line.' }, w.deps);
    expect(r).toMatchObject({ updated: true, changed: true, status: 'REJECTED' });
    expect(row(w, 'comeback', 'en')).toMatchObject({ metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT', rejectionRecommendation: 'Remove the emoji from the first line.' });
    expect(w.notify.mock.calls[0][0]).toMatchObject({ kind: 'template_rejected', severity: 'action', params: { template: 'Come-back offer', language: 'en', reason: 'INVALID_FORMAT' }, email: true });
    expect(w.notify.mock.calls[0][0].dedupeKey).toBe(`template:${idOf(w, 'comeback')}:REJECTED`);
    expect(milestones(w)).toEqual([]); // a rejection is never a milestone
  });

  test('reason NONE is not a rejection reason; REINSTATED means APPROVED; FLAGGED keeps the sendable state', async () => {
    const w = await submitted();
    const id = idOf(w, 'comeback');
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: 'REJECTED', reason: 'NONE' }, w.deps);
    expect(row(w, 'comeback', 'en').rejectedReason).toBeNull();
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: 'REINSTATED' }, w.deps);
    expect(row(w, 'comeback', 'en').metaStatus).toBe('APPROVED');
    const f = await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: 'FLAGGED' }, w.deps);
    expect(f.changed).toBe(false);
    expect(row(w, 'comeback', 'en')).toMatchObject({ metaStatus: 'APPROVED', metaStatusRaw: 'FLAGGED' });
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: 'PAUSED' }, w.deps);
    expect(row(w, 'comeback', 'en').metaStatus).toBe('PAUSED');
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: 'SOMETHING_NEW' }, w.deps);
    expect(row(w, 'comeback', 'en').metaStatus).toBe('ERROR'); // unknown values are non-sendable
  });

  test('the same status twice never notifies twice, even after a round trip (dedupe key by id + status)', async () => {
    const w = await submitted();
    const id = idOf(w, 'comeback');
    for (const s of ['APPROVED', 'PAUSED', 'APPROVED']) await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, statusRaw: s }, w.deps);
    const keys = perTemplate(w).map((a) => a.dedupeKey);
    expect(keys).toEqual([`template:${id}:APPROVED`, `template:${id}:APPROVED`]); // the notification store dedupes the repeat
    expect(milestones(w).map((a) => a.dedupeKey)).toEqual(['templates:first_approved', 'templates:first_approved']); // same key: one e-mail at most
  });

  test('category update without a status; the unknown template / foreign workspace is ignored', async () => {
    const w = await submitted();
    const id = idOf(w, 'promotion_new_arrival');
    const c = await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: id, category: 'marketing' }, w.deps);
    expect(c).toMatchObject({ updated: true, changed: false });
    expect(row(w, 'promotion_new_arrival', 'en').category).toBe('MARKETING');
    expect(await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: '99999', statusRaw: 'APPROVED' }, w.deps)).toEqual({ updated: false, changed: false, reason: 'unknown_template' });
    expect(await starter.applyTemplateStatusUpdate({ workspaceId: WS2, templateId: id, statusRaw: 'APPROVED' }, w.deps)).toMatchObject({ updated: false });
    expect(row(w, 'promotion_new_arrival', 'en').metaStatus).toBe('PENDING');
    // name with a mismatching language part is not matched
    const name = row(w, 'promotion_new_arrival', 'en').metaTemplateName;
    expect(await starter.applyTemplateStatusUpdate({ workspaceId: WS, name, language: 'ar', statusRaw: 'APPROVED' }, w.deps)).toMatchObject({ updated: false });
  });

  test('a rejection first seen by the poll (no reason) is completed by the later webhook, without a second notification', async () => {
    const w = await submitted();
    const r = row(w, 'comeback', 'en');
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: r.metaTemplateId, statusRaw: 'REJECTED' }, w.deps);
    expect(row(w, 'comeback', 'en')).toMatchObject({ metaStatus: 'REJECTED', rejectedReason: null });
    const again = await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: r.metaTemplateId, statusRaw: 'REJECTED', reason: 'ABUSIVE_CONTENT', recommendation: 'Tone it down.' }, w.deps);
    expect(again.changed).toBe(false);
    expect(row(w, 'comeback', 'en')).toMatchObject({ rejectedReason: 'ABUSIVE_CONTENT', rejectionRecommendation: 'Tone it down.' });
    expect(w.notify).toHaveBeenCalledTimes(1);
    // a stored reason is never overwritten by a later duplicate
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: r.metaTemplateId, statusRaw: 'REJECTED', reason: 'SCAM' }, w.deps);
    expect(row(w, 'comeback', 'en').rejectedReason).toBe('ABUSIVE_CONTENT');
  });

  test('the setup test template is tracked but does not notify', async () => {
    const w = await submitted();
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: idOf(w, 'setup_test'), statusRaw: 'APPROVED' }, w.deps);
    expect(w.notify).not.toHaveBeenCalled();
    expect(row(w, 'setup_test', 'en').metaStatus).toBe('APPROVED');
  });

  test('a failing notification never breaks the status update', async () => {
    const w = await submitted();
    w.notify.mockRejectedValue(new Error('boom'));
    const r = await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: idOf(w, 'comeback'), statusRaw: 'APPROVED' }, w.deps);
    expect(r.changed).toBe(true);
  });
});

describe('coalesced approval e-mails (milestones)', () => {
  const ENGLISH_KEYS = ['welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation'];
  async function submittedAll(opts) {
    const w = makeWorld(opts);
    await starter.seedStarterTemplates(WS, w.deps);
    for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    return w;
  }
  const decide = (w, key, language, statusRaw, extra) => starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: row(w, key, language).metaTemplateId, statusRaw, ...(extra || {}) }, w.deps);

  test('7 approvals: every one is an in-app notification WITHOUT e-mail; exactly two e-mailed milestones (first, all)', async () => {
    const w = await submittedAll();
    const seen = [];
    for (const key of ENGLISH_KEYS) {
      await decide(w, key, 'en', 'APPROVED');
      seen.push(milestones(w).length);
    }
    expect(perTemplate(w)).toHaveLength(7);
    expect(perTemplate(w).every((a) => a.kind === 'template_approved' && a.email === false)).toBe(true);
    expect(seen).toEqual([1, 1, 1, 1, 1, 1, 2]); // 1st approval: first_approved; 2nd to 6th: nothing; 7th: all_approved
    const [first, all] = milestones(w);
    expect(first).toMatchObject({ workspaceId: WS, kind: 'template_approved', dedupeKey: 'templates:first_approved', severity: 'success', params: { count: 1, total: 7 }, email: true, actionPath: '/setup/approvals' });
    expect(all).toMatchObject({ workspaceId: WS, kind: 'template_approved', dedupeKey: 'templates:all_approved', severity: 'success', params: { count: 7, total: 7 }, email: true, actionPath: '/setup/approvals' });
    expect(milestones(w).filter((a) => a.email)).toHaveLength(2);
  });

  test('the milestone params are exactly { count, total }: no template name, no key, no language, no phone number', async () => {
    const w = await submittedAll();
    for (const key of ENGLISH_KEYS) await decide(w, key, 'en', 'APPROVED');
    for (const a of milestones(w)) {
      expect(Object.keys(a.params).sort()).toEqual(['count', 'total']);
      expect(Object.values(a.params).every((v) => Number.isInteger(v))).toBe(true);
      expect(JSON.stringify(a)).not.toMatch(/Welcome|Weekend|Come-back|966|wf_/);
    }
  });

  test('the same decision delivered again (webhook + poll, re-delivery) adds no notification call at all', async () => {
    const w = await submittedAll();
    await decide(w, 'comeback', 'en', 'APPROVED');
    const calls = w.notify.mock.calls.length;
    await decide(w, 'comeback', 'en', 'APPROVED');
    await decide(w, 'comeback', 'en', 'APPROVED');
    expect(w.notify).toHaveBeenCalledTimes(calls);
  });

  test('a rejected template keeps "all approved" from firing; the rest of the approvals still produce the first milestone only', async () => {
    const w = await submittedAll();
    await decide(w, 'comeback', 'en', 'REJECTED', { reason: 'INVALID_FORMAT' });
    for (const key of ENGLISH_KEYS.filter((k) => k !== 'comeback')) await decide(w, key, 'en', 'APPROVED');
    expect(milestones(w).map((a) => a.dedupeKey)).toEqual(['templates:first_approved']);
    // fixed and resubmitted by the merchant, approved later: now every English template is approved
    row(w, 'comeback', 'en').metaStatus = 'PENDING';
    await decide(w, 'comeback', 'en', 'APPROVED');
    expect(milestones(w).map((a) => a.dedupeKey)).toEqual(['templates:first_approved', 'templates:all_approved']);
  });

  test('the internal setup test template never counts: not as the first approval, not as one of the total', async () => {
    const w = await submittedAll();
    await decide(w, 'setup_test', 'en', 'APPROVED');
    expect(w.notify).not.toHaveBeenCalled();
    await decide(w, 'welcome_optin', 'en', 'APPROVED');
    expect(milestones(w)).toEqual([expect.objectContaining({ dedupeKey: 'templates:first_approved', params: { count: 1, total: 7 } })]);
  });

  test('"all approved" means every non-blocked ENGLISH starter template: Arabic rows (pending, rejected or blocked) do not hold it back', async () => {
    const w = await submittedAll({ languages: ['en', 'ar'] });
    expect(submits(w).some((c) => c.payload.language === 'ar')).toBe(true); // Arabic rows are in flight too
    await decide(w, 'comeback', 'ar', 'REJECTED', { reason: 'ABUSIVE_CONTENT' });
    for (const key of ENGLISH_KEYS) await decide(w, key, 'en', 'APPROVED');
    expect(milestones(w).map((a) => [a.dedupeKey, a.params])).toEqual([['templates:first_approved', { count: 1, total: 13 }], ['templates:all_approved', { count: 7, total: 7 }]]);
  });

  test('an Arabic template approved before any English one is still "the first starter template" (total = every non-blocked starter row)', async () => {
    const w = await submittedAll({ languages: ['en', 'ar'] });
    await decide(w, 'comeback', 'ar', 'APPROVED');
    expect(milestones(w)).toEqual([expect.objectContaining({ dedupeKey: 'templates:first_approved', params: { count: 1, total: 13 }, email: true })]);
    await decide(w, 'comeback', 'en', 'APPROVED'); // the second approval: nothing more
    expect(milestones(w)).toHaveLength(1);
  });

  test('a workspace with ONE non-blocked English template: the first approval is also the last, so ONLY "all approved" is sent', async () => {
    process.env.ONBOARDING_STARTER_TEMPLATES = 'comeback';
    const w = await submittedAll();
    await decide(w, 'comeback', 'en', 'APPROVED');
    expect(milestones(w).map((a) => [a.dedupeKey, a.params, a.email])).toEqual([['templates:all_approved', { count: 1, total: 1 }, true]]);
    await decide(w, 'setup_test', 'en', 'APPROVED'); // the test template changes nothing
    expect(milestones(w)).toHaveLength(1);
  });

  test('tenant isolation: the approved templates of another workspace count for nothing (rows are read workspace-scoped)', async () => {
    const w = await submittedAll();
    ENGLISH_KEYS.forEach((key, i) => w.Template.seed({ workspaceId: WS2, key, language: 'en', source: 'library', metaTemplateId: `9${i}`, metaStatus: 'APPROVED' }));
    await decide(w, 'comeback', 'en', 'APPROVED');
    expect(milestones(w)).toEqual([expect.objectContaining({ workspaceId: WS, dedupeKey: 'templates:first_approved', params: { count: 1, total: 7 } })]);
    const readFilters = w.Template.calls.filter((c) => c[0] === 'find').map((c) => c[1]);
    expect(readFilters.length).toBeGreaterThan(0);
    expect(readFilters.every((f) => f && f.workspaceId === WS)).toBe(true);
  });

  test('a failing notification (or a failing read of the rows) never breaks the status update', async () => {
    const w = await submittedAll();
    w.notify.mockRejectedValue(new Error('boom'));
    const r = await decide(w, 'comeback', 'en', 'APPROVED');
    expect(r).toMatchObject({ updated: true, changed: true, status: 'APPROVED' });
    const w2 = await submittedAll();
    const realFind = w2.Template.find;
    w2.Template.find = (...a) => { if (w2.notify.mock.calls.length > 0) throw new Error('db down'); return realFind(...a); };
    const r2 = await decide(w2, 'comeback', 'en', 'APPROVED');
    expect(r2).toMatchObject({ updated: true, changed: true, status: 'APPROVED' });
    expect(row(w2, 'comeback', 'en').metaStatus).toBe('APPROVED');
  });
});

describe('pollStatuses (scheduler hook)', () => {
  async function submitted() {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    w.client.calls.length = 0;
    return w;
  }

  test('one list call per workspace with the merchant token; APPROVED and REJECTED applied', async () => {
    const w = await submitted();
    w.clock.advance(61 * 60 * 1000);
    w.client.setStatus('wf_439011_welcome_optin_en_v1', 'APPROVED');
    w.client.setStatus('wf_439011_comeback_en_v1', 'REJECTED', { rejected_reason: 'INVALID_FORMAT', rejection_info: { reason: 'INVALID_FORMAT', recommendation: 'Fix it' } });
    const r = await starter.pollStatuses({ submit: false }, w.deps);
    expect(r).toMatchObject({ workspaces: 1, checked: 5, changed: 2, errors: 0 });
    const lists = w.client.calls.filter((c) => c.name === 'list');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ token: MERCHANT_TOKEN, wabaId: 'W1' });
    expect(lists[0].query.name).toBe('wf_439011_');
    expect(row(w, 'welcome_optin', 'en').metaStatus).toBe('APPROVED');
    expect(row(w, 'comeback', 'en')).toMatchObject({ metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT', rejectionRecommendation: 'Fix it' });
    expect(perTemplate(w).map((a) => a.kind).sort()).toEqual(['template_approved', 'template_rejected']);
    expect(milestones(w).map((a) => a.dedupeKey)).toEqual(['templates:first_approved']);
  });

  test('PENDING rows are re-read at most hourly', async () => {
    const w = await submitted();
    const a = await starter.pollStatuses({ submit: false }, w.deps); // just submitted: lastCheckedAt = now
    expect(a.checked).toBe(0);
    expect(w.client.calls.filter((c) => c.name === 'list')).toHaveLength(0);
    w.clock.advance(30 * 60 * 1000);
    expect((await starter.pollStatuses({ submit: false }, w.deps)).checked).toBe(0);
    w.clock.advance(31 * 60 * 1000);
    expect((await starter.pollStatuses({ submit: false }, w.deps)).checked).toBe(5);
    expect(w.client.calls.filter((c) => c.name === 'list')).toHaveLength(1);
    // checked again straight away: nothing to do
    expect((await starter.pollStatuses({ submit: false }, w.deps)).checked).toBe(0);
    // decided rows are not polled any more
    w.clock.advance(61 * 60 * 1000);
    for (const r of w.Template.rows) if (r.metaTemplateId) r.metaStatus = 'APPROVED';
    expect((await starter.pollStatuses({ submit: false }, w.deps)).checked).toBe(0);
  });

  test('uses opts.now and a template missing on Meta only gets its check time bumped', async () => {
    const w = await submitted();
    w.client.remote.length = 0;
    const later = new Date(w.clock.now().getTime() + 2 * 3600 * 1000);
    const r = await starter.pollStatuses({ now: later, submit: false }, w.deps);
    expect(r).toMatchObject({ checked: 5, changed: 0 });
    expect(row(w, 'setup_test', 'en')).toMatchObject({ metaStatus: 'PENDING', lastCheckedAt: later });
  });

  test('inactive subscription: skipped; not connected / reconnect needed: skipped without throwing', async () => {
    const w = await submitted();
    w.clock.advance(2 * 3600 * 1000);
    w.getGateState.mockResolvedValue({ enrolled: true, sub: { state: 'cancelled' } });
    expect(await starter.pollStatuses({ submit: false }, w.deps)).toMatchObject({ workspaces: 0, skipped: 1, checked: 0 });
    w.getGateState.mockResolvedValue({ enrolled: true, sub: { state: 'active' } });
    w.Conn.rows[0].needsReconnect = true;
    expect(await starter.pollStatuses({ submit: false }, w.deps)).toMatchObject({ workspaces: 1, skipped: 1, checked: 0 });
    expect(w.client.calls.filter((c) => c.name === 'list')).toHaveLength(0);
    w.getGateState.mockRejectedValue(new Error('db down'));
    w.Conn.rows[0].needsReconnect = false;
    expect((await starter.pollStatuses({ submit: false }, w.deps)).skipped).toBe(1); // unknown subscription: not polled
  });

  test('a Graph failure is counted, never thrown; a revoked token flips the connection', async () => {
    const w = await submitted();
    w.clock.advance(2 * 3600 * 1000);
    w.client.failNext.push({ name: 'list', err: Object.assign(new Error('x'), { code: 190, kind: 'reconnect' }) });
    const r = await starter.pollStatuses({ submit: false }, w.deps);
    expect(r.errors).toBe(1);
    expect(w.connect.reportGraphError).toHaveBeenCalledWith(WS, expect.any(Error));
  });

  test('opts.workspaceId restricts both the poll and the submit run to one workspace', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.seedStarterTemplates(WS2, w.deps);
    const r = await starter.submitPending({ workspaceId: WS2 }, w.deps);
    expect(r.workspaces).toBe(1);
    expect(w.Template.rows.filter((x) => String(x.workspaceId) === WS && x.metaTemplateId)).toHaveLength(0);
    const p = await starter.pollStatuses({ workspaceId: WS, submit: true }, w.deps);
    expect(p.submit.workspaces).toBe(1);
    expect(w.Template.rows.filter((x) => String(x.workspaceId) === WS && x.metaTemplateId).length).toBeGreaterThan(0);
  });

  test('also submits queued rows (submitPending) unless submit:false', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const r = await starter.pollStatuses({}, w.deps);
    expect(r.submit).toMatchObject({ workspaces: 1, submitted: 5 });
    expect(submits(w)).toHaveLength(5);
    const r2 = await starter.pollStatuses({ submit: false }, w.deps);
    expect(r2.submit).toBeUndefined();
    expect(submits(w)).toHaveLength(5);
  });

  test('submitPending: only workspaces with an active subscription, 5 per workspace per tick', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.getGateState.mockResolvedValue({ enrolled: true, sub: { state: 'pending' } });
    expect(await starter.submitPending({}, w.deps)).toMatchObject({ workspaces: 0, submitted: 0 });
    expect(submits(w)).toHaveLength(0);
    w.getGateState.mockResolvedValue({ enrolled: true, sub: { state: 'active' } });
    expect(await starter.submitPending({}, w.deps)).toMatchObject({ workspaces: 1, submitted: 5 });
  });
});

describe('resubmit', () => {
  async function withRejected(opts) {
    const w = makeWorld(opts);
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    const r = row(w, 'comeback', 'en');
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: r.metaTemplateId, statusRaw: 'REJECTED', reason: 'INVALID_FORMAT' }, w.deps);
    w.client.calls.length = 0;
    return w;
  }

  test('only after REJECTED', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    await expect(starter.resubmit({ workspaceId: WS, key: 'welcome_optin', language: 'en' }, w.deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'NOT_REJECTED' } });
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'ar' }, w.deps)).rejects.toMatchObject({ details: { reason: 'NOT_REJECTED' } }); // queued, never submitted
    await expect(starter.resubmit({ workspaceId: WS, key: 'nope', language: 'en' }, w.deps)).rejects.toMatchObject({ details: { reason: 'UNKNOWN_TEMPLATE' } });
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'fr' }, w.deps)).rejects.toMatchObject({ details: { reason: 'UNKNOWN_TEMPLATE' } });
    expect(submits(w).length).toBe(5);
  });

  test('a new revision with a new name; the row is PENDING again with the reason cleared', async () => {
    const w = await withRejected();
    const out = await starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps);
    expect(out.template).toMatchObject({ key: 'comeback', language: 'en', status: 'pending', revision: 2, rejectedReason: null, canResubmit: false });
    const c = submits(w);
    expect(c).toHaveLength(1);
    expect(c[0].payload.name).toBe('wf_439011_comeback_en_v2');
    expect(c[0].payload.allow_category_change).toBe(true);
    expect(c[0].token).toBe(MERCHANT_TOKEN);
    expect(row(w, 'comeback', 'en')).toMatchObject({ revision: 2, metaTemplateName: 'wf_439011_comeback_en_v2', metaStatus: 'PENDING', rejectedReason: null, rejectionRecommendation: null, submitClaimedAt: null });
    // a second resubmit is refused: it is not rejected any more
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps)).rejects.toMatchObject({ details: { reason: 'NOT_REJECTED' } });
  });

  test('edited text within the constraints is submitted; the merge fields cannot change', async () => {
    const w = await withRejected();
    const body = 'Hi {name}, we have missed you! Enjoy {discount}% off your next order until {date}. See you soon.';
    await starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en', edits: { body } }, w.deps);
    const sent = submits(w)[0].payload;
    expect(sent.components.find((x) => x.type === 'BODY').text).toBe('Hi {{1}}, we have missed you! Enjoy {{2}}% off your next order until {{3}}. See you soon.');
    const w2 = await withRejected();
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en', edits: { body: 'Hi {name}, come back {coupon} soon friend of ours, we miss you a lot.' } }, w2.deps))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'TEMPLATE_FIELDS_CHANGED' } });
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en', edits: { body: '{name}, come back for {discount}% off until {date}, we miss you.' } }, w2.deps))
      .rejects.toMatchObject({ details: { reason: 'TEMPLATE_INVALID', errors: ['body_starts_with_variable'] } }); // same fields, but Meta rejects a body that starts with a variable
    expect(submits(w2)).toHaveLength(0);
  });

  test('validateVariant failures are reported with their codes and nothing is sent', async () => {
    const w = await withRejected();
    const long = `Hi {name}, {discount} off until {date}. ${'x'.repeat(1100)}`;
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en', edits: { body: long } }, w.deps))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { reason: 'TEMPLATE_INVALID', errors: expect.arrayContaining(['body_too_long']) } });
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en', edits: { body: '' } }, w.deps))
      .rejects.toMatchObject({ details: { reason: 'TEMPLATE_FIELDS_CHANGED' } });
    expect(submits(w)).toHaveLength(0);
    expect(row(w, 'comeback', 'en')).toMatchObject({ revision: 1, metaStatus: 'REJECTED' });
  });

  test('a Meta failure leaves the row REJECTED at its old revision with the claim released', async () => {
    const w = await withRejected();
    w.client.failNext.push({ name: 'submit', err: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) });
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps)).rejects.toMatchObject({ code: 'META_UNREACHABLE' });
    expect(row(w, 'comeback', 'en')).toMatchObject({ revision: 1, metaStatus: 'REJECTED', submitClaimedAt: null, lastErrorCode: 'META_UNREACHABLE' });
    const out = await starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps);
    expect(out.template.revision).toBe(2);
  });

  test('revoked token -> WHATSAPP_RECONNECT_REQUIRED and the connection is flagged', async () => {
    const w = await withRejected();
    w.client.failNext.push({ name: 'submit', err: Object.assign(new Error('x'), { code: 190, kind: 'reconnect' }) });
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps)).rejects.toMatchObject({ code: 'WHATSAPP_RECONNECT_REQUIRED' });
    expect(w.connect.reportGraphError).toHaveBeenCalledTimes(1);
  });

  test('ceiling applies to resubmits too', async () => {
    const w = await withRejected();
    process.env.ONBOARDING_TEMPLATE_CEILING = '5';
    await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps)).rejects.toMatchObject({ code: 'TEMPLATE_LIMIT_REACHED' });
    expect(submits(w)).toHaveLength(0);
  });

  test('tenant isolation: another workspace cannot resubmit', async () => {
    const w = await withRejected();
    await expect(starter.resubmit({ workspaceId: WS2, key: 'comeback', language: 'en' }, w.deps)).rejects.toMatchObject({ details: { reason: 'UNKNOWN_TEMPLATE' } });
  });
});

describe('routes (mini app)', () => {
  const { createRouter } = require('../../../routes/onboarding/templates');
  const mkApp = (w, extra = {}, user = { id: 'u1', workspaceId: WS, role: 'owner' }) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = user; next(); });
    app.use(createRouter({ moduleDeps: w.deps, memberGate: (req, res, next) => next(), ...extra })); // the live membership gate has its own tests (requireOnboardingAccess, testMessageRecipient)
    return app;
  };
  const freshLimiter = () => ({ limiter: require('../../../shared/onboarding/rateLimit').createLimiter() });

  test('exports a router and createRouter', () => {
    expect(typeof require('../../../routes/onboarding/templates')).toBe('function');
    expect(typeof createRouter).toBe('function');
  });

  test('GET /templates -> { templates, capacity } (no token, no Meta names)', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const res = await request(mkApp(w, { rateLimitDeps: freshLimiter() })).get('/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(16);
    expect(res.body.templates[0]).toMatchObject({ key: 'welcome_optin', language: 'en', status: 'queued', title: { en: expect.any(String), ar: expect.any(String) } });
    expect(res.body.capacity).toMatchObject({ ceiling: 90, total: 16, queued: 8 });
    expect(JSON.stringify(res.body)).not.toMatch(/wf_[0-9a-f]{6}_|EAA/);
  });

  test('POST /templates/submit queues, submits up to 3 and returns the rows', async () => {
    const w = makeWorld();
    const res = await request(mkApp(w, { rateLimitDeps: freshLimiter() })).post('/templates/submit').send({});
    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(3);
    expect(res.body.templates).toHaveLength(16);
    expect(res.body.templates.filter((t) => t.status === 'pending')).toHaveLength(3);
    expect(submits(w)).toHaveLength(3);
    const again = await request(mkApp(w, { rateLimitDeps: freshLimiter() })).post('/templates/submit').send({});
    expect(again.body.submitted).toBe(3); // idempotent queue; 3 more rows submitted
    expect(w.Template.rows).toHaveLength(16);
  });

  test('POST /templates/submit: 3 per hour, then 429 RATE_LIMITED with Retry-After', async () => {
    const w = makeWorld();
    const app = mkApp(w, { rateLimitDeps: freshLimiter() });
    for (let i = 0; i < 3; i += 1) expect((await request(app).post('/templates/submit').send({})).status).toBe(200);
    const res = await request(app).post('/templates/submit').send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('POST /templates/submit without a connection: 200, rows queued, blocked says why', async () => {
    const w = makeWorld({ connStatus: null });
    const res = await request(mkApp(w, { rateLimitDeps: freshLimiter() })).post('/templates/submit').send({});
    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(0);
    expect(res.body.blocked).toEqual({ code: 'WHATSAPP_NOT_CONNECTED', nextStep: 'connect' });
    expect(res.body.templates).toHaveLength(16);
  });

  test('POST /templates/submit at the ceiling: 409 TEMPLATE_LIMIT_REACHED', async () => {
    const w = makeWorld();
    process.env.ONBOARDING_TEMPLATE_CEILING = '1';
    const app = mkApp(w, { rateLimitDeps: freshLimiter() });
    expect((await request(app).post('/templates/submit').send({})).status).toBe(200);
    const res = await request(app).post('/templates/submit').send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_LIMIT_REACHED', nextStep: 'approvals' });
  });

  test('the workspace comes from the token, never from the body or the query', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    const app = mkApp(w, { rateLimitDeps: freshLimiter() }, { id: 'u2', workspaceId: WS2, role: 'owner' });
    const res = await request(app).get('/templates?workspaceId=' + WS).send({ workspaceId: WS });
    expect(res.body.templates).toEqual([]);
    const sub = await request(app).post('/templates/submit').send({ workspaceId: WS });
    expect(sub.body.blocked).toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' }); // WS2 has no connection
    expect(w.Template.rows.filter((r) => String(r.workspaceId) === WS2)).toHaveLength(16);
    expect(submits(w)).toHaveLength(0);
  });

  test('POST /templates/:key/:language/resubmit: validation, edits, success', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    await starter.applyTemplateStatusUpdate({ workspaceId: WS, templateId: row(w, 'comeback', 'en').metaTemplateId, statusRaw: 'REJECTED', reason: 'INVALID_FORMAT' }, w.deps);
    const app = mkApp(w, { rateLimitDeps: freshLimiter() });
    expect((await request(app).post('/templates/comeback/fr/resubmit').send({})).status).toBe(422);
    expect((await request(app).post('/templates/BAD KEY/en/resubmit').send({})).body.code).toBe('VALIDATION_FAILED');
    const notRejected = await request(app).post('/templates/welcome_optin/en/resubmit').send({});
    expect(notRejected.status).toBe(422);
    expect(notRejected.body.details.reason).toBe('NOT_REJECTED');
    const ok = await request(app).post('/templates/comeback/en/resubmit').send({ body: 'ignored', unknown: 1 });
    expect(ok.status).toBe(422); // the edited body drops the merge fields
    expect(ok.body.details.reason).toBe('TEMPLATE_FIELDS_CHANGED');
    const done = await request(app).post('/templates/comeback/en/resubmit').send({});
    expect(done.status).toBe(200);
    expect(done.body.template).toMatchObject({ key: 'comeback', status: 'pending', revision: 2 });
  });

  test('module errors become JSON bodies (NOT_IMPLEMENTED stub -> 503), never a stack', async () => {
    const stub = { listStatuses: () => { const e = new Error('later'); e.code = 'NOT_IMPLEMENTED'; e.status = 503; throw e; }, getCapacity: async () => ({}) };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 'u', workspaceId: WS }; next(); });
    app.use(createRouter({ starterTemplates: stub, rateLimitDeps: freshLimiter() }));
    const res = await request(app).get('/templates');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+|node_modules/);
  });
});

describe('no secrets anywhere', () => {
  test('a whole seed + submit + poll + status cycle leaves no token or full-number-like secret in rows, notifications, tracking or logs', async () => {
    const w = makeWorld({ languages: ['en', 'ar'] });
    const lines = await captureLogs(async () => {
      await starter.seedStarterTemplates(WS, w.deps);
      for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: WS }, w.deps);
      w.clock.advance(2 * 3600 * 1000);
      w.client.setStatus('wf_439011_comeback_ar_v1', 'REJECTED', { rejected_reason: 'INVALID_FORMAT' });
      await starter.pollStatuses({ submit: false }, w.deps);
    });
    const everything = flat([w.Template.rows, w.notify.mock.calls, w.track.mock.calls]) + lines.join('\n');
    expect(everything).not.toContain(MERCHANT_TOKEN);
    expect(everything).not.toContain(PLATFORM_TOKEN);
    expect(everything).not.toMatch(/tokenEncrypted|Bearer/);
  });

  test('OnbError instances never carry a token', async () => {
    const w = makeWorld({ vaultFails: true });
    await starter.seedStarterTemplates(WS, w.deps);
    const err = await starter.submitQueued({ workspaceId: WS }, w.deps).catch((e) => e);
    expect(err).toBeInstanceOf(OnbError);
    expect(flat({ m: err.message, c: err.code, d: err.details })).not.toContain(MERCHANT_TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Review fixes R2-01 / R7-03: the platform account is never touched; template rows remember the account they were submitted to and are
// queued again when the merchant connects a different WhatsApp Business account.
// ---------------------------------------------------------------------------------------------------------------------------------
describe('template rows follow the WhatsApp Business account (review R7-03)', () => {
  async function submitted(w) {
    await starter.seedStarterTemplates(WS, w.deps);
    for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    return w.Template.rows.filter((r) => r.metaTemplateName);
  }

  test('every submitted row stores the WABA it was submitted to (submit and resubmit)', async () => {
    const w = makeWorld();
    const rows = await submitted(w);
    expect(rows).toHaveLength(8);
    rows.forEach((r) => expect(r.wabaId).toBe('W1'));
    const target = rows.find((r) => r.key === 'comeback');
    w.client.setStatus(target.metaTemplateName, 'REJECTED', { rejected_reason: 'INVALID_FORMAT' });
    w.clock.advance(61 * 60 * 1000);
    await starter.pollStatuses({ workspaceId: WS, submit: false }, w.deps);
    expect(row(w, 'comeback', 'en').metaStatus).toBe('REJECTED');
    w.Conn.rows[0].ids.wabaId = 'W2'; // by then the merchant has another account
    await starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps);
    expect(row(w, 'comeback', 'en')).toMatchObject({ wabaId: 'W2', revision: 2 });
    expect(submits(w).pop().wabaId).toBe('W2');
  });

  test('requeueForAccount: every row of the OTHER account is reset to queued (names, ids, status, attempts, revision); blocked reasons and other workspaces stay', async () => {
    const w = makeWorld({ languages: ['en', 'ar'] });
    const rows = await submitted(w);
    expect(rows.length).toBeGreaterThan(0);
    const other = seedTemplate(w, { key: 'comeback', language: 'en', workspaceId: WS2, wabaId: 'W9', metaTemplateName: 'wf_other_comeback_en_v1', metaTemplateId: '777', metaStatus: 'APPROVED', revision: 4 });
    const bumped = row(w, 'promotion_weekend', 'en');
    Object.assign(bumped, { revision: 3, lastErrorCode: 'META_ERROR', rejectedReason: 'x', submittedAt: new Date(), qualityScore: 'GREEN' });
    const blockedBefore = w.Template.rows.filter((r) => String(r.workspaceId) === WS).map((r) => [r.key, r.language, r.blockedReason]);

    const res = await starter.requeueForAccount({ workspaceId: WS, wabaId: 'W2' }, w.deps);
    expect(res).toEqual({ requeued: w.Template.rows.filter((r) => String(r.workspaceId) === WS).length });
    for (const r of w.Template.rows.filter((x) => String(x.workspaceId) === WS)) {
      expect(r).toMatchObject({ wabaId: 'W2', revision: 1, attempts: 0 });
      for (const f of ['metaTemplateId', 'metaTemplateName', 'metaStatus', 'metaStatusRaw', 'rejectedReason', 'rejectionRecommendation', 'qualityScore', 'submittedAt', 'lastCheckedAt', 'lastErrorCode']) {
        expect([f, r[f]]).toEqual([f, undefined]);
      }
    }
    expect(w.Template.rows.filter((r) => String(r.workspaceId) === WS).map((r) => [r.key, r.language, r.blockedReason])).toEqual(blockedBefore);
    expect(other).toMatchObject({ wabaId: 'W9', metaTemplateId: '777', metaStatus: 'APPROVED', revision: 4 }); // another tenant: untouched
    // the same account again changes nothing
    expect(await starter.requeueForAccount({ workspaceId: WS, wabaId: 'W2' }, w.deps)).toEqual({ requeued: 0 });
  });

  test('rows from before the account was recorded count as the old account\'s; bad input does nothing', async () => {
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    w.Template.rows.forEach((r) => { delete r.wabaId; });
    const calls = w.Template.calls.length;
    expect(await starter.requeueForAccount({}, w.deps)).toEqual({ requeued: 0 });
    expect(await starter.requeueForAccount({ workspaceId: WS }, w.deps)).toEqual({ requeued: 0 });
    expect(await starter.requeueForAccount({ wabaId: 'W2' }, w.deps)).toEqual({ requeued: 0 });
    expect(w.Template.calls.length).toBe(calls); // no write at all
    expect((await starter.requeueForAccount({ workspaceId: WS, wabaId: 'W2' }, w.deps)).requeued).toBe(16);
  });

  test('after the switch the queued rows are submitted to the NEW account with the same names (revision 1) and stamped with it', async () => {
    const w = makeWorld();
    await submitted(w);
    const firstNames = submits(w).map((c) => c.payload.name).sort();
    w.Conn.rows[0].ids.wabaId = 'W2';
    await starter.requeueForAccount({ workspaceId: WS, wabaId: 'W2' }, w.deps);
    const before = submits(w).length;
    for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps);
    const again = submits(w).slice(before);
    expect(again).toHaveLength(8);
    again.forEach((c) => expect(c.wabaId).toBe('W2'));
    expect(again.map((c) => c.payload.name).sort()).toEqual(firstNames);
    w.Template.rows.filter((r) => r.metaTemplateName).forEach((r) => expect(r.wabaId).toBe('W2'));
  });
});

describe('the platform account is never used for a merchant (review R2-01)', () => {
  const keep = { waba: process.env.WA_WABA_ID, phone: process.env.WA_PHONE_ID };
  afterEach(() => {
    for (const [k, v] of [['WA_WABA_ID', keep.waba], ['WA_PHONE_ID', keep.phone]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('a connection that holds the platform WABA (or phone) is "not connected": nothing is decrypted, submitted, read or sent', async () => {
    for (const env of [{ WA_WABA_ID: 'W1' }, { WA_PHONE_ID: 'P1' }]) {
      Object.assign(process.env, env);
      const w = makeWorld();
      await starter.seedStarterTemplates(WS, w.deps); // seeding is DB only: allowed
      await expect(starter.loadMerchantContext(WS, w.deps, { needPhoneId: true })).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' });
      await expect(starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps)).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' });
      await expect(starter.resubmit({ workspaceId: WS, key: 'comeback', language: 'en' }, w.deps)).rejects.toBeInstanceOf(OnbError);
      const polled = await starter.pollStatuses({ workspaceId: WS, submit: false }, w.deps);
      expect(polled.errors).toBe(0);
      expect(w.client.calls).toHaveLength(0);
      expect(w.vault.decrypt).not.toHaveBeenCalled();
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  test('other accounts are unaffected (the ids are compared as strings, an unset env means no platform account)', async () => {
    process.env.WA_WABA_ID = 'W-platform';
    process.env.WA_PHONE_ID = 'P-platform';
    const w = makeWorld();
    await starter.seedStarterTemplates(WS, w.deps);
    expect((await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps)).submitted).toBe(5);
    delete process.env.WA_WABA_ID;
    delete process.env.WA_PHONE_ID;
    expect((await starter.submitQueued({ workspaceId: WS, max: 5 }, w.deps)).submitted).toBe(3);
  });
});
