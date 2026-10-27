// utils/settingsCache.js per workspace: isolation between customers, the senderContext fallback, invalidate scoping, and the
// unchanged legacy behaviour (no workspace anywhere = the first Settings document). Models are in-memory fakes: no database.
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

let mockDocs;
let mockOldestWorkspaceId;
const mockCalls = { findOne: [], create: [] };
let mockHold = null; // when set, findOne({workspaceId}) waits for it (race tests)

jest.mock('../models/Settings', () => ({
  findOne: jest.fn(async (filter) => {
    mockCalls.findOne.push(filter === undefined ? undefined : { ...filter });
    if (mockHold) await mockHold;
    if (!filter || Object.keys(filter).length === 0) return mockDocs[0] || null;
    if (Object.prototype.hasOwnProperty.call(filter, 'workspaceId')) {
      if (filter.workspaceId === null) return mockDocs.find((d) => d.workspaceId == null) || null;
      return mockDocs.find((d) => d.workspaceId != null && String(d.workspaceId) === String(filter.workspaceId)) || null;
    }
    return null;
  }),
  create: jest.fn(async (obj) => {
    mockCalls.create.push({ ...obj });
    const doc = { currency: 'AUD', ...obj };
    mockDocs.push(doc);
    return doc;
  }),
}));
jest.mock('../models/Workspace', () => ({
  findOne: jest.fn(() => ({ sort: () => ({ select: async () => (mockOldestWorkspaceId ? { _id: mockOldestWorkspaceId } : null) }) })),
}));

let cache;
let senderContext;

beforeEach(() => {
  jest.resetModules();
  mockDocs = [];
  mockOldestWorkspaceId = null;
  mockHold = null;
  mockCalls.findOne.length = 0;
  mockCalls.create.length = 0;
  cache = require('../utils/settingsCache');
  senderContext = require('../utils/senderContext');
});

const replaceDoc = (i, patch) => { mockDocs[i] = { ...mockDocs[i], ...patch }; }; // a NEW object: the cache holds the old reference
const scopedReads = () => mockCalls.findOne.filter((f) => f && f.workspaceId && f.workspaceId !== null);

describe('per-workspace isolation', () => {
  test('each workspace reads its own document and currency', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR', flowCooldownDays: 5 }, { workspaceId: B, currency: 'USD', flowCooldownDays: 1 });
    expect(await cache.getCurrency(A)).toBe('SAR');
    expect(await cache.getCurrency(B)).toBe('USD');
    expect((await cache.getSettings(A)).flowCooldownDays).toBe(5);
    expect((await cache.getSettings(B)).flowCooldownDays).toBe(1);
  });

  test('the second read of a workspace is served from the cache (no second query)', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    await cache.getCurrency(A);
    await cache.getCurrency(A);
    await cache.getSettings(A);
    expect(scopedReads()).toHaveLength(1);
  });

  test('workspace ids can be given as ObjectId-like objects (toString) as well as strings', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    expect(await cache.getCurrency({ toString: () => A })).toBe('SAR');
  });

  test('a workspace with no Settings document gets one stamped with ITS id (never an unscoped document) and the AUD default', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    expect(await cache.getCurrency(B)).toBe('AUD');
    expect(mockCalls.create).toEqual([{ workspaceId: B }]);
    expect(await cache.getCurrency(A)).toBe('SAR'); // the other workspace is untouched
  });

  test('a document without a currency falls back to AUD', async () => {
    mockDocs.push({ workspaceId: A, currency: '' });
    expect(await cache.getCurrency(A)).toBe('AUD');
  });

  test('concurrent first reads of one workspace share one query', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    const [x, y, z] = await Promise.all([cache.getCurrency(A), cache.getCurrency(A), cache.getCurrency(A)]);
    expect([x, y, z]).toEqual(['SAR', 'SAR', 'SAR']);
    expect(scopedReads()).toHaveLength(1);
  });

  test('a failed read is not cached: the next call tries again', async () => {
    const Settings = require('../models/Settings');
    Settings.findOne.mockImplementationOnce(async () => { throw new Error('db down'); });
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    await expect(cache.getCurrency(A)).rejects.toThrow('db down');
    expect(await cache.getCurrency(A)).toBe('SAR');
  });
});

describe('the sender context is the default workspace', () => {
  test('no argument inside senderContext.run reads that workspace', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    expect(await senderContext.run(A, () => cache.getCurrency())).toBe('SAR');
    expect(await senderContext.run(B, () => cache.getCurrency())).toBe('USD');
    expect(await senderContext.run(B, () => senderContext.run(A, () => cache.getCurrency()))).toBe('SAR'); // innermost wins
  });

  test('an explicit argument beats the context', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    expect(await senderContext.run(A, () => cache.getCurrency(B))).toBe('USD');
  });

  test('two concurrent contexts never see each other\'s currency', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    const slow = (ws) => senderContext.run(ws, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return cache.getCurrency();
    });
    expect(await Promise.all([slow(A), slow(B), slow(A), slow(B)])).toEqual(['SAR', 'USD', 'SAR', 'USD']);
  });

  test('senderContext.enter (webhook style) is honoured too', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    await new Promise((resolve, reject) => {
      senderContext.run(null, async () => {
        senderContext.enter(A);
        try { expect(await cache.getCurrency()).toBe('SAR'); resolve(); } catch (e) { reject(e); }
      });
    });
  });
});

describe('legacy behaviour: no workspace anywhere = the first Settings document', () => {
  test('returns the first document whatever its workspace, and caches it', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    expect(await cache.getCurrency()).toBe('SAR');
    await cache.getSettings();
    expect(mockCalls.findOne.filter((f) => f === undefined)).toHaveLength(1);
  });

  test('creates an (unscoped) document when there is none, exactly as before', async () => {
    expect(await cache.getCurrency()).toBe('AUD');
    expect(mockCalls.create).toEqual([{}]);
  });

  test('runPlatform (platform-owned work) has no workspace: first document', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    expect(await senderContext.runPlatform(() => cache.getCurrency())).toBe('SAR');
  });

  test('a malformed workspace id degrades to the legacy first document, never throws a cast error', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    expect(await cache.getCurrency('not-an-object-id')).toBe('SAR');
  });

  test('a pre-multi-tenant document (no workspaceId) is read by the OLDEST workspace only', async () => {
    mockDocs.push({ currency: 'SAR', flowCooldownDays: 9 }); // orphan
    mockOldestWorkspaceId = A;
    expect((await cache.getSettings(A)).flowCooldownDays).toBe(9);
    expect(mockCalls.create).toEqual([]);
    // any other workspace does not inherit it: it gets its own stamped default document
    expect(await cache.getCurrency(B)).toBe('AUD');
    expect(mockCalls.create).toEqual([{ workspaceId: B }]);
  });

  test('without any Workspace document the orphan is not adopted', async () => {
    mockDocs.push({ currency: 'SAR' });
    mockOldestWorkspaceId = null;
    expect(await cache.getCurrency(A)).toBe('AUD');
  });
});

describe('invalidate', () => {
  test('invalidate(id) drops only that workspace', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    await cache.getCurrency(A);
    await cache.getCurrency(B);
    mockCalls.findOne.length = 0;
    replaceDoc(0, { currency: 'EUR' });
    cache.invalidate(A);
    expect(await cache.getCurrency(A)).toBe('EUR'); // re-read
    expect(await cache.getCurrency(B)).toBe('USD'); // still cached
    expect(scopedReads().map((f) => f.workspaceId)).toEqual([A]);
  });

  test('invalidate() inside a context drops that context\'s workspace only', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    await cache.getCurrency(A);
    await cache.getCurrency(B);
    mockCalls.findOne.length = 0;
    replaceDoc(0, { currency: 'EUR' });
    replaceDoc(1, { currency: 'GBP' });
    senderContext.run(A, () => cache.invalidate());
    expect(await cache.getCurrency(A)).toBe('EUR');
    expect(await cache.getCurrency(B)).toBe('USD'); // B kept its cached (old) value: not invalidated
  });

  test('invalidate() with no context at all clears everything (the old behaviour, a superset)', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' }, { workspaceId: B, currency: 'USD' });
    await cache.getCurrency(A);
    await cache.getCurrency(B);
    await cache.getCurrency(); // legacy entry
    replaceDoc(0, { currency: 'EUR' });
    replaceDoc(1, { currency: 'GBP' });
    cache.invalidate();
    expect(await cache.getCurrency(A)).toBe('EUR');
    expect(await cache.getCurrency(B)).toBe('GBP');
    expect(await cache.getCurrency()).toBe('EUR'); // first document, re-read
  });

  test('invalidating a workspace never leaves a stale legacy first-document entry behind', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    expect(await cache.getCurrency()).toBe('SAR');
    replaceDoc(0, { currency: 'EUR' });
    cache.invalidate(A);
    expect(await cache.getCurrency()).toBe('EUR');
  });

  test('an invalidate that lands while a read is in flight is not overwritten by the stale result', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    let release;
    mockHold = new Promise((r) => { release = r; });
    const first = cache.getCurrency(A); // reads 'SAR' (the document object) but waits
    await new Promise((r) => setImmediate(r));
    cache.invalidate(A);
    mockHold = null;
    release();
    await first;
    mockDocs[0] = { workspaceId: A, currency: 'EUR' }; // a new document replaces it
    mockCalls.findOne.length = 0;
    expect(await cache.getCurrency(A)).toBe('EUR'); // not served from the stale in-flight result
    expect(scopedReads()).toHaveLength(1);
  });

  test('a per-workspace entry expires on its own after the safety-net TTL (the legacy entry does not)', async () => {
    mockDocs.push({ workspaceId: A, currency: 'SAR' });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await cache.getCurrency(A);
      await cache.getCurrency();
      replaceDoc(0, { currency: 'EUR' });
      now += 4 * 60 * 1000;
      expect(await cache.getCurrency(A)).toBe('SAR'); // still cached
      now += 2 * 60 * 1000;
      expect(await cache.getCurrency(A)).toBe('EUR'); // expired -> re-read
      expect(await cache.getCurrency()).toBe('SAR'); // the legacy entry never expires on its own (explicit invalidate only)
      expect(mockCalls.findOne.filter((f) => f === undefined)).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });
});
