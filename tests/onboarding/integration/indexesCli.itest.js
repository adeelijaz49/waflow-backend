'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_idxcli`;
assertThrowawayDb();

// `node scripts/onboarding-admin.js indexes [--create]` against a REAL (throwaway) mongod, review R7 (operational note): Mongoose builds the
// declared indexes silently at first use and swallows the errors, so staff need a command that LISTS what really exists, shouts when a UNIQUE
// index is missing and, on request, builds the declared ones explicitly (never dropping anything). The flag is OFF throughout.
// The connection runs with autoIndex:false so that "nothing was built yet" is a state this suite can really start from.
const mongoose = require('mongoose');

let cli;
let indexCheck;
let models;
const run = (argv) => cli.run(cli.parseArgs(argv), cli.buildDeps());
const NAMES = ['OnboardingState', 'WhatsAppConnection', 'WhatsAppClaim', 'OnboardingEvent', 'OnboardingInbound', 'OnboardingNotification', 'OnboardingSupportRequest', 'OnboardingTemplate', 'OnboardingAdminLog'];
const indexNames = async (name) => (await mongoose.connection.collection(name).indexes()).map((i) => i.name).sort();

beforeAll(async () => {
  delete process.env.ONBOARDING_FLOW; // the command must work BEFORE the feature is switched on
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  cli = require('../../../scripts/onboarding-admin');
  indexCheck = require('../../../shared/onboarding/indexCheck');
  models = Object.fromEntries(NAMES.map((n) => [n, require(`../../../models/${n}`)]));
  await Promise.all(Object.values(models).map((m) => m.init())); // autoIndex is off: the (empty) collections get created, the declared indexes do not
});
afterAll(async () => { await mongoose.disconnect(); });

describe('indexes (read-only) on a database where the declared indexes were never built', () => {
  test('it lists the nine collections, warns loudly about every missing UNIQUE index and exits 1; it creates nothing', async () => {
    for (const n of NAMES) expect(await indexNames(models[n].collection.collectionName)).toEqual(['_id_']); // what a swallowed index build leaves behind
    const r = await run(['indexes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('WARNING: UNIQUE INDEXES ARE MISSING');
    const unique = NAMES.flatMap((n) => indexCheck.declaredOf(models[n]).filter((d) => d.unique).map((d) => ({ coll: models[n].collection.collectionName, key: indexCheck.keyString(d.key) })));
    expect(unique.length).toBe(5);
    for (const u of unique) expect(r.out).toContain(`!!!   ${u.coll} { ${u.key} }`);
    expect(unique.map((u) => u.coll).sort()).toEqual(['onboardingnotifications', 'onboardingstates', 'onboardingsupportrequests', 'onboardingtemplates', 'whatsappconnections']);
    expect(unique.find((u) => u.coll === 'onboardingsupportrequests').key).toBe('workspaceId:1,kind:1,windowKey:1');
    for (const n of NAMES) expect(r.out).toContain(`${models[n].collection.collectionName}: exists`);
    expect(r.out).toMatch(/missing: workspaceId:1 {2}UNIQUE/);
    expect(r.out).toContain('Run again with --create');
    for (const n of NAMES) expect(await indexNames(models[n].collection.collectionName)).toEqual(['_id_']); // listing is read-only: still nothing built
    expect(r.out).not.toMatch(/mongodb:\/\//);
  });
});

describe('indexes --create builds the declared indexes and never drops anything', () => {
  test('a foreign index that already exists stays; every collection gets its declared indexes; the second run is clean (exit 0)', async () => {
    // an index nobody declared, on a collection that already exists: --create must leave it alone
    await mongoose.connection.collection('onboardingevents').createIndex({ somethingElse: 1 }, { name: 'foreign_idx' });
    const made = await run(['indexes', '--create']);
    expect(made.code).toBe(0);
    for (const n of NAMES) expect(made.out).toContain(`Indexes built for ${models[n].collection.collectionName}`);
    expect(made.out).toContain('All declared UNIQUE indexes are present');
    expect(made.out).not.toContain('WARNING');

    const live = async (name) => mongoose.connection.collection(name).indexes();
    const support = await live('onboardingsupportrequests');
    expect(support.find((i) => i.name === 'workspaceId_1_kind_1_windowKey_1')).toMatchObject({ unique: true, key: { workspaceId: 1, kind: 1, windowKey: 1 } });
    expect((await live('onboardingstates')).some((i) => i.unique && i.key.workspaceId === 1)).toBe(true);
    expect((await live('whatsappconnections')).some((i) => i.unique && i.key.workspaceId === 1)).toBe(true);
    expect((await live('onboardingnotifications')).some((i) => i.unique && i.key.workspaceId === 1 && i.key.dedupeKey === 1)).toBe(true);
    expect((await live('onboardingtemplates')).some((i) => i.unique && i.key.workspaceId === 1 && i.key.key === 1 && i.key.language === 1)).toBe(true);
    expect((await live('onboardingevents')).some((i) => i.name === 'foreign_idx')).toBe(true); // nothing was dropped

    const again = await run(['indexes']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('All declared UNIQUE indexes are present');
    expect(again.out).toContain('UNIQUE');
    expect(again.out).not.toContain('does NOT exist');
    const twice = await run(['indexes', '--create']); // idempotent
    expect(twice.code).toBe(0);
  });

  test('the unique support-request index really makes the 10-minute window atomic on this database', async () => {
    const SupportRequest = models.OnboardingSupportRequest;
    const ws = String(new mongoose.Types.ObjectId());
    const mk = () => SupportRequest.create({ workspaceId: ws, kind: 'number_help', status: 'open', windowKey: 'itest-window' });
    const results = await Promise.allSettled([mk(), mk(), mk(), mk(), mk()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe(11000));
    expect(await SupportRequest.countDocuments({ workspaceId: ws })).toBe(1);
  });
});

describe('a conflicting index that the database refuses to replace is SEEN (nothing is dropped, the other collections are still built)', () => {
  test('a NON-unique index with the declared key: reported as missing UNIQUE, the explicit build reports the database error and exit 1 stays', async () => {
    const conn2 = mongoose.createConnection(`${process.env.MONGODB_URI}2`, { autoIndex: false });
    await conn2.asPromise();
    try {
      const M2 = {
        OnboardingSupportRequest: conn2.model('OnboardingSupportRequest', models.OnboardingSupportRequest.schema),
        OnboardingState: conn2.model('OnboardingState', models.OnboardingState.schema),
      };
      // somebody created the same key as a plain index (under the name the unique one would get)
      await conn2.collection('onboardingsupportrequests').createIndex({ workspaceId: 1, kind: 1, windowKey: 1 }, { name: 'workspaceId_1_kind_1_windowKey_1' });
      const report = await indexCheck.inspect({ models: M2 });
      expect(report.ok).toBe(false);
      expect(report.missingUnique).toEqual(expect.arrayContaining([{ collection: 'onboardingsupportrequests', key: 'workspaceId:1,kind:1,windowKey:1' }]));
      const built = await indexCheck.create({ models: M2 });
      expect(built.errors).toHaveLength(1);
      expect(built.errors[0]).toMatchObject({ model: 'OnboardingSupportRequest', collection: 'onboardingsupportrequests' });
      expect(['85', '86', 'IndexOptionsConflict', 'IndexKeySpecsConflict']).toContain(built.errors[0].code);
      expect(built.created.map((c) => c.model)).toEqual(['OnboardingState']); // the failing collection did not stop the other one
      const after = await indexCheck.inspect({ models: M2 });
      expect(after.ok).toBe(false); // still missing: the report keeps saying so
      const live = await conn2.collection('onboardingsupportrequests').indexes();
      expect(live.find((i) => i.name === 'workspaceId_1_kind_1_windowKey_1').unique).toBeFalsy(); // not replaced, not dropped
    } finally {
      await conn2.close();
    }
  });
});
