'use strict';
// Review R7: the staff CLI lists the open Meta data-deletion requests and can mark one processed (nothing is deleted), and
// `indexes [--create]` lists the indexes of the nine onboarding collections and says LOUDLY when a UNIQUE index is missing (Mongoose swallows
// the errors of its automatic index build, so on Cosmos DB this is the way to see them).
const cli = require('../../../scripts/onboarding-admin');
const dataDeletion = require('../../../shared/onboarding/dataDeletion');
const indexCheck = require('../../../shared/onboarding/indexCheck');
const { createFakeModel } = require('./_b0Store');

const CODE = 'a1b2c3d4e5f60718293a4b5c';
const WS = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = new Date('2026-10-15T10:00:00Z');

describe('parseArgs: deletion-done and indexes', () => {
  test('both commands and their flags', () => {
    expect(cli.parseArgs(['deletion-done', CODE])).toMatchObject({ command: 'deletion-done', code: CODE, workspaceId: null, notes: undefined });
    expect(cli.parseArgs(['deletion-done', CODE.toUpperCase(), '--notes', 'done by hand'])).toMatchObject({ code: CODE, notes: 'done by hand' });
    expect(cli.parseArgs(['indexes'])).toMatchObject({ command: 'indexes', create: false });
    expect(cli.parseArgs(['indexes', '--create'])).toMatchObject({ command: 'indexes', create: true });
  });
  test.each([
    [['deletion-done'], 'request id'],
    [['deletion-done', 'not-hex'], 'request id'],
    [['deletion-done', 'abc'], 'request id'],
    [['deletion-done', CODE, 'extra'], 'Too many arguments'],
    [['deletion-done', CODE, '--dry-run'], 'does not apply'],
    [['indexes', '--notes', 'x'], 'does not apply'],
    [['indexes', WS], 'Too many arguments'],
    [['list', '--create'], 'does not apply'],
    [['status', WS, '--create'], 'does not apply'],
  ])('%j -> UsageError', (argv, message) => {
    let err;
    try { cli.parseArgs(argv); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(cli.UsageError);
    expect(err.message).toContain(message);
  });
  test('USAGE names both', () => {
    expect(cli.USAGE).toContain('deletion-done');
    expect(cli.USAGE).toContain('indexes [--create]');
  });
});

function inboundWith(rows) {
  const m = createFakeModel();
  rows.forEach((r) => m.seed(r));
  return m;
}
const deletionRows = () => [
  { _id: `metacb:${CODE}`, type: 'data_deletion', status: 'processing', startedAt: new Date('2026-10-14T00:00:00Z'), workspaceId: WS, outcome: 'awaiting_staff user:FB1' },
  { _id: 'metacb:deauth:x', type: 'deauthorize', status: 'processing', startedAt: new Date('2026-10-14T00:00:00Z') },
];

describe('list: the open data-deletion requests', () => {
  const base = (listDeletions) => ({ listStates: async () => [], listDeletions });
  test('an open request is shown with its id, time, workspace and note, plus how to close it', async () => {
    const Inbound = inboundWith(deletionRows());
    const out = await cli.run({ command: 'list' }, base(() => dataDeletion.listRequests({ OnboardingInbound: Inbound })));
    expect(out.code).toBe(0);
    expect(out.out).toContain('OPEN Meta data-deletion requests: 1');
    expect(out.out).toContain(`${CODE}  received 2026-10-14T00:00:00.000Z  workspace ${WS}  awaiting_staff user:FB1`);
    expect(out.out).toContain('deletion-done <request id>');
    expect(out.out).not.toContain('deauth');
  });
  test('none open: says so; a failing read does not fail the list', async () => {
    const none = await cli.run({ command: 'list' }, base(() => dataDeletion.listRequests({ OnboardingInbound: inboundWith([]) })));
    expect(none.out).toContain('Open Meta data-deletion requests: none');
    const failing = await cli.run({ command: 'list' }, base(async () => { throw new Error('db down mongodb://user:secret@host/db'); }));
    expect(failing.code).toBe(0);
    expect(failing.out).toContain('could not be read');
    expect(failing.out).not.toContain('secret');
  });
  test('without a listDeletions dependency the list is as before', async () => {
    const r = await cli.run({ command: 'list' }, { listStates: async () => [] });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('data-deletion');
  });
});

describe('deletion-done', () => {
  function mk(rows = deletionRows(), logFails = false) {
    const Inbound = inboundWith(rows);
    const order = [];
    const OnboardingAdminLog = { create: jest.fn(async (row) => { order.push(`log:${row.action}`); if (logFails) throw new Error('log down'); return row; }) };
    const orig = Inbound.updateOne;
    Inbound.updateOne = async (...a) => { order.push('inbound.updateOne'); return orig(...a); };
    return { Inbound, OnboardingAdminLog, order, deps: { adminUser: 'cli:ops', dataDeletion, stateDeps: { OnboardingInbound: Inbound, OnboardingAdminLog, now: () => NOW } } };
  }
  const args = (over = {}) => ({ command: 'deletion-done', code: CODE, notes: 'rows removed', ...over });

  test('writes the admin log row FIRST (as cli:<user>, ip cli), then marks the request done; nothing is deleted', async () => {
    const t = mk();
    const r = await cli.run(args(), t.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Marked processed');
    expect(r.out).toContain('nothing was deleted');
    expect(t.order).toEqual(['log:data_deletion_done', 'inbound.updateOne']);
    expect(t.OnboardingAdminLog.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, action: 'data_deletion_done', target: `metacb:${CODE}`, adminUser: 'cli:ops', notes: 'rows removed', ip: 'cli' }));
    expect(t.Inbound.rows.find((x) => x._id === `metacb:${CODE}`)).toMatchObject({ status: 'done', finishedAt: NOW, outcome: 'processed_by_staff user:FB1' });
    expect(t.Inbound.rows).toHaveLength(2);
  });
  test('idempotent: a second run says so and writes nothing', async () => {
    const t = mk();
    await cli.run(args(), t.deps);
    t.order.length = 0;
    const r = await cli.run(args(), t.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain('already marked processed');
    expect(t.order).toEqual([]);
  });
  test('an unknown request, or a ledger row that is not a data-deletion request, exits 1 and changes nothing', async () => {
    const t = mk();
    const unknown = await cli.run(args({ code: 'f'.repeat(24) }), t.deps);
    expect(unknown.code).toBe(1);
    expect(t.order).toEqual([]);
    const other = mk([{ _id: `metacb:${'e'.repeat(24)}`, type: 'deauthorize', status: 'processing' }]);
    expect((await cli.run(args({ code: 'e'.repeat(24) }), other.deps)).code).toBe(1);
    expect(other.order).toEqual([]);
  });
  test('a failing audit row aborts: the request stays open (log first)', async () => {
    const t = mk(deletionRows(), true);
    const r = await cli.run(args(), t.deps);
    expect(r.code).toBe(1);
    expect(t.order).toEqual(['log:data_deletion_done']);
    expect(t.Inbound.rows.find((x) => x._id === `metacb:${CODE}`).status).toBe('processing');
  });
});

describe('dataDeletion module', () => {
  test('listRequests: open and done are separate bounded reads through the status index; rows are viewed without internals', async () => {
    const Inbound = inboundWith([...deletionRows(), { _id: `metacb:${'c'.repeat(24)}`, type: 'data_deletion', status: 'done', startedAt: new Date('2026-10-01T00:00:00Z') }]);
    const res = await dataDeletion.listRequests({ OnboardingInbound: Inbound });
    expect(res.open.map((r) => r.code)).toEqual([CODE]);
    expect(res.done.map((r) => r.code)).toEqual(['c'.repeat(24)]);
    expect(res.open[0]).toEqual({ code: CODE, status: 'processing', receivedAt: new Date('2026-10-14T00:00:00Z'), workspaceId: WS, outcome: 'awaiting_staff user:FB1' });
    const finds = Inbound.calls.filter((c) => c[0] === 'find').map((c) => c[1]);
    expect(finds).toEqual([{ type: 'data_deletion', status: 'processing' }, { type: 'data_deletion', status: 'done' }]);
  });
  test('markProcessed validates the code and the audit values (control characters never reach the log)', async () => {
    const Inbound = inboundWith(deletionRows());
    const log = { create: jest.fn(async (r) => r) };
    const deps = { OnboardingInbound: Inbound, OnboardingAdminLog: log, now: () => NOW };
    for (const bad of [undefined, null, '', 'zz', 'g'.repeat(24), 'a'.repeat(15), 'a'.repeat(65), {}, 7]) {
      await expect(dataDeletion.markProcessed({ code: bad, by: 'x' }, deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_CODE' } });
    }
    await expect(dataDeletion.markProcessed({ code: 'f'.repeat(24), by: 'x' }, deps)).rejects.toMatchObject({ details: { reason: 'NOT_FOUND' } });
    await dataDeletion.markProcessed({ code: CODE, by: `ops${String.fromCharCode(10)}<script>`, notes: `a${String.fromCharCode(0)}b${'n'.repeat(900)}` }, deps);
    const row = log.create.mock.calls[0][0];
    expect(row.adminUser).toBe('ops<script>');
    expect(row.notes.startsWith('a b')).toBe(true);
    expect(row.notes).toHaveLength(500);
    await dataDeletion.markProcessed({ code: CODE, by: '' }, deps); // already done: no second row
    expect(log.create).toHaveBeenCalledTimes(1);
  });
  test('no deletion anywhere in the new modules and scripts', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['shared/onboarding/dataDeletion.js', 'shared/onboarding/indexCheck.js', 'shared/onboarding/metaCallbacks.js', 'scripts/onboarding-admin.js', 'routes/adminOnboarding.js']) {
      expect(fs.readFileSync(path.join(__dirname, '../../..', f), 'utf8')).not.toMatch(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|dropIndex|dropIndexes|syncIndexes|dropDatabase|dropCollection|bulkWrite/);
    }
  });
});

// ---- indexes -----------------------------------------------------------------------------------------------------------------
function fakeModel(name, declared, live, { exists = true, createFails = null } = {}) {
  return {
    schema: { indexes: () => declared },
    collection: { collectionName: name.toLowerCase(), indexes: async () => { if (!exists) throw Object.assign(new Error('ns does not exist'), { code: 26 }); return live; } },
    createIndexes: jest.fn(async () => { if (createFails) throw createFails; }),
  };
}
const ID = { name: '_id_', key: { _id: 1 } };
function allModels(over = {}) {
  const m = {};
  for (const n of indexCheck.MODEL_NAMES) m[n] = fakeModel(n, [[{ workspaceId: 1 }, {}]], [ID, { name: 'workspaceId_1', key: { workspaceId: 1 } }]);
  m.OnboardingState = fakeModel('OnboardingState', [[{ workspaceId: 1 }, { unique: true }], [{ progress: 1 }, {}]], [ID, { name: 'workspaceId_1', key: { workspaceId: 1 }, unique: true }, { name: 'progress_1', key: { progress: 1 } }]);
  m.WhatsAppConnection = fakeModel('WhatsAppConnection', [[{ workspaceId: 1 }, { unique: true }]], [ID, { name: 'workspaceId_1', key: { workspaceId: 1 }, unique: true }]);
  m.OnboardingNotification = fakeModel('OnboardingNotification', [[{ workspaceId: 1, dedupeKey: 1 }, { unique: true }]], [ID, { name: 'workspaceId_1_dedupeKey_1', key: { workspaceId: 1, dedupeKey: 1 }, unique: true }]);
  m.OnboardingTemplate = fakeModel('OnboardingTemplate', [[{ workspaceId: 1, key: 1, language: 1 }, { unique: true }]], [ID, { name: 'k', key: { workspaceId: 1, key: 1, language: 1 }, unique: true }]);
  m.OnboardingSupportRequest = fakeModel('OnboardingSupportRequest', [[{ workspaceId: 1, kind: 1, windowKey: 1 }, { unique: true }]], [ID, { name: 'w', key: { workspaceId: 1, kind: 1, windowKey: 1 }, unique: true }]);
  return { ...m, ...over };
}

describe('indexCheck.inspect', () => {
  test('all declared indexes present: ok, nothing missing, the nine collections listed', async () => {
    const r = await indexCheck.inspect({ models: allModels() });
    expect(r.ok).toBe(true);
    expect(r.missingUnique).toEqual([]);
    expect(r.collections).toHaveLength(9);
    expect(r.collections.map((c) => c.model)).toEqual(indexCheck.MODEL_NAMES);
    expect(r.collections.find((c) => c.model === 'OnboardingState').indexes.map((i) => i.name)).toEqual(['_id_', 'workspaceId_1', 'progress_1']);
  });
  test('a missing UNIQUE index is reported with its collection and key; a missing plain index is listed but not "unique"', async () => {
    const models = allModels({
      OnboardingNotification: fakeModel('OnboardingNotification', [[{ workspaceId: 1, dedupeKey: 1 }, { unique: true }]], [ID]),
      OnboardingState: fakeModel('OnboardingState', [[{ workspaceId: 1 }, { unique: true }], [{ progress: 1 }, {}]], [ID, { name: 'workspaceId_1', key: { workspaceId: 1 }, unique: true }]),
    });
    const r = await indexCheck.inspect({ models });
    expect(r.ok).toBe(false);
    expect(r.missingUnique).toEqual([{ collection: 'onboardingnotification', key: 'workspaceId:1,dedupeKey:1' }]);
    expect(r.collections.find((c) => c.model === 'OnboardingState').missing).toEqual([{ key: { progress: 1 }, unique: false }]);
  });
  test('an index with the right keys but NOT unique does not count for a unique one; the key ORDER matters', async () => {
    const notUnique = await indexCheck.inspect({ models: allModels({ WhatsAppConnection: fakeModel('WhatsAppConnection', [[{ workspaceId: 1 }, { unique: true }]], [ID, { name: 'workspaceId_1', key: { workspaceId: 1 } }]) }) });
    expect(notUnique.ok).toBe(false);
    const order = await indexCheck.inspect({ models: allModels({ OnboardingTemplate: fakeModel('OnboardingTemplate', [[{ workspaceId: 1, key: 1, language: 1 }, { unique: true }]], [ID, { name: 'x', key: { language: 1, key: 1, workspaceId: 1 }, unique: true }]) }) });
    expect(order.ok).toBe(false);
  });
  test('a collection that does not exist yet (nothing has used it) is reported as such and its unique indexes are missing', async () => {
    const r = await indexCheck.inspect({ models: allModels({ OnboardingState: fakeModel('OnboardingState', [[{ workspaceId: 1 }, { unique: true }]], [], { exists: false }) }) });
    expect(r.collections.find((c) => c.model === 'OnboardingState').exists).toBe(false);
    expect(r.missingUnique).toHaveLength(1);
  });
  test('any other listing error surfaces (it is never swallowed)', async () => {
    const broken = fakeModel('OnboardingState', [], []);
    broken.collection.indexes = async () => { throw new Error('boom'); };
    await expect(indexCheck.inspect({ models: allModels({ OnboardingState: broken }) })).rejects.toThrow('boom');
  });
  test('the REAL models declare their unique indexes (the four of the design plus the support-request window)', async () => {
    const real = {};
    for (const n of indexCheck.MODEL_NAMES) real[n] = require(`../../../models/${n}`);
    const uniques = [];
    for (const n of indexCheck.MODEL_NAMES) for (const d of indexCheck.declaredOf(real[n])) if (d.unique) uniques.push(`${n}:${indexCheck.keyString(d.key)}`);
    expect(uniques.sort()).toEqual([
      'OnboardingNotification:workspaceId:1,dedupeKey:1',
      'OnboardingState:workspaceId:1',
      'OnboardingSupportRequest:workspaceId:1,kind:1,windowKey:1',
      'OnboardingTemplate:workspaceId:1,key:1,language:1',
      'WhatsAppConnection:workspaceId:1',
    ]);
  });
});

describe('indexCheck.create', () => {
  test('calls createIndexes on all nine models, reports the errors of one without stopping the others, never drops', async () => {
    const models = allModels({ OnboardingEvent: fakeModel('OnboardingEvent', [], [ID], { createFails: Object.assign(new Error('Index build failed: unsupported option'), { code: 67 }) }) });
    const r = await indexCheck.create({ models });
    expect(r.created).toHaveLength(8);
    expect(r.errors).toEqual([{ model: 'OnboardingEvent', collection: 'onboardingevent', code: '67', message: 'Index build failed: unsupported option' }]);
    for (const n of indexCheck.MODEL_NAMES) expect(models[n].createIndexes).toHaveBeenCalledTimes(1);
  });
});

describe('the indexes command', () => {
  const run = (args, models) => cli.run({ command: 'indexes', create: false, ...args }, { indexes: { inspect: () => indexCheck.inspect({ models }), create: () => indexCheck.create({ models }) } });

  test('all present: lists every collection with its indexes and exits 0', async () => {
    const r = await run({}, allModels());
    expect(r.code).toBe(0);
    expect(r.out).toContain('onboardingstate: exists');
    expect(r.out).toContain('workspaceId_1  workspaceId:1  UNIQUE');
    expect(r.out).toContain('All declared UNIQUE indexes are present');
    expect(r.out).not.toContain('WARNING');
  });
  test('a missing UNIQUE index: a loud warning naming it, exit 1, and the hint to use --create', async () => {
    const r = await run({}, allModels({ OnboardingNotification: fakeModel('OnboardingNotification', [[{ workspaceId: 1, dedupeKey: 1 }, { unique: true }]], [ID]) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('!!! WARNING: UNIQUE INDEXES ARE MISSING !!!');
    expect(r.out).toContain('onboardingnotification { workspaceId:1,dedupeKey:1 }');
    expect(r.out).toContain('--create');
    expect(r.out).toContain('UNIQUE  <-- !!!');
  });
  test('--create builds first, then inspects: a fixed index is fine; a refused build is SHOWN with its error and exits 1', async () => {
    let built = false;
    const ok = fakeModel('OnboardingNotification', [[{ workspaceId: 1, dedupeKey: 1 }, { unique: true }]], [ID]);
    ok.createIndexes = jest.fn(async () => { built = true; });
    ok.collection.indexes = async () => (built ? [ID, { name: 'n', key: { workspaceId: 1, dedupeKey: 1 }, unique: true }] : [ID]);
    const fixed = await run({ create: true }, allModels({ OnboardingNotification: ok }));
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain('Indexes built for onboardingnotification');
    expect(ok.createIndexes).toHaveBeenCalledTimes(1);
    const refused = fakeModel('OnboardingNotification', [[{ workspaceId: 1, dedupeKey: 1 }, { unique: true }]], [ID], { createFails: Object.assign(new Error('unique index not supported here'), { code: 115 }) });
    const bad = await run({ create: true }, allModels({ OnboardingNotification: refused }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('ERROR building the indexes of onboardingnotification: 115 unique index not supported here');
    expect(bad.out).toContain('The explicit build above did not fix it');
  });
  test('works without the flag: it never reads ONBOARDING_FLOW', async () => {
    const saved = process.env.ONBOARDING_FLOW;
    delete process.env.ONBOARDING_FLOW;
    try { expect((await run({}, allModels())).code).toBe(0); } finally { if (saved !== undefined) process.env.ONBOARDING_FLOW = saved; }
  });
  test('a database error is reported as a failure with the connection string redacted', async () => {
    const broken = fakeModel('OnboardingState', [], []);
    broken.collection.indexes = async () => { throw new Error('connect failed mongodb+srv://user:pw@cluster.example/db'); };
    const r = await run({}, allModels({ OnboardingState: broken }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Failed:');
    expect(r.out).not.toContain('pw@cluster');
  });
});
