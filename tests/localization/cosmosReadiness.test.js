// Production runs on Cosmos DB for MongoDB, which rejects a sort that no index serves
// (a multi-field sort needs a compound index; a single-field one needs an index on that field).
// These tests pin the choices made for the NEW code so a later edit cannot quietly bring back a
// sort that works on a laptop mongod and fails in production.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const fs = require('fs');
const path = require('path');
const campaigns = require('../../shared/localization/campaigns');
const LocalizedCampaign = require('../../models/LocalizedCampaign');
const { makeKit, oid } = require('./campaignTestKit');

const ROOT = path.join(__dirname, '..', '..');

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

describe('Cosmos DB sort rules', () => {
  test('the campaign list sorts by _id only (always indexed), newest first', async () => {
    const kit = makeKit();
    const ws = oid();
    const specs = [];
    const find = kit.deps.LocalizedCampaign.find.bind(kit.deps.LocalizedCampaign);
    kit.deps.LocalizedCampaign.find = (...args) => {
      const query = find(...args);
      const sort = query.sort.bind(query);
      query.sort = (spec) => { specs.push(spec); return sort(spec); };
      return query;
    };
    await campaigns.list({ workspaceId: ws, query: {} }, kit.deps);
    expect(specs).toEqual([{ _id: -1 }]);
  });

  test('every field the model sorts on has an index of its own (overview "last sent")', () => {
    const indexed = LocalizedCampaign.schema.indexes().filter(([keys]) => Object.keys(keys).length === 1).map(([keys]) => Object.keys(keys)[0]);
    expect(indexed).toContain('finishedAt');
    const logIndexed = require('../../models/LocalizationAdminLog').schema.indexes().filter(([keys]) => Object.keys(keys).length === 1).map(([keys]) => Object.keys(keys)[0]);
    expect(logIndexed).toContain('createdAt'); // the admin page's "last changes"
  });

  test('no literal multi-field .sort({...}) in the localisation code (it would need a compound index per query)', () => {
    const offenders = [];
    for (const file of [...sourceFiles('shared/localization'), ...sourceFiles('routes/localization'), 'routes/adminLocalization.js', 'scripts/localization-flag.js', 'scripts/i18n-review.js']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of text.matchAll(/\.sort\(\{([^}]*)\}\)/g)) {
        if (match[1].split(',').filter((part) => part.trim()).length > 1) offenders.push(`${file}: .sort({${match[1]}})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('indexes on collections that already exist in production', () => {
  test('LocalizedTemplate (created by the first build) gets no new index: linkedPromotionId is looked up through the workspaceId index', () => {
    const indexes = require('../../models/LocalizedTemplate').schema.indexes().map(([keys]) => Object.keys(keys).join(','));
    expect(indexes.some((k) => k.includes('linkedPromotionId'))).toBe(false);
    expect(indexes).toEqual(expect.arrayContaining(['workspaceId', 'workspaceId,key', 'workspaceId,linkedMessageNodeId']));
    expect(indexes).toHaveLength(3);
  });
  test('the promotion lookup of senderVariants is workspace-scoped (it needs no index of its own)', async () => {
    const calls = [];
    const LocalizedTemplate = { find: (filter) => { calls.push(filter); return { lean: async () => [] }; } };
    await require('../../shared/localization/senderVariants').listCandidates({ LocalizedTemplate }, { workspaceId: oid(), sender: 'promotion', promotion: { _id: oid() }, node: null });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]).sort()).toEqual(['archived', 'linkedPromotionId', 'workspaceId']);
  });
});
