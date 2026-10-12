// The in-memory store used by the campaign tests must itself behave like MongoDB
// where the campaign code depends on it — otherwise green tests would prove nothing.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const { makeKit, matches, oid } = require('./campaignTestKit');

const WS = oid();
const OTHER = oid();

describe('query matching (non-strict, like find())', () => {
  const doc = { a: 1, b: 'x', c: null, n: { m: 5 }, tags: ['p', 'q'], d: new Date(2026, 1, 1) };

  test.each([
    [{ a: 1 }, true], [{ a: 2 }, false], [{ a: { $ne: 2 } }, true], [{ missing: { $ne: true } }, true], [{ missing: { $exists: false } }, true],
    [{ b: { $in: ['x', 'y'] } }, true], [{ b: { $nin: ['x'] } }, false], [{ 'n.m': { $gte: 5 } }, true], [{ 'n.m': { $gt: 5 } }, false],
    [{ c: null }, true], [{ missing: null }, true], [{ c: { $exists: true } }, true], [{ tags: 'q' }, true], [{ tags: { $in: ['z'] } }, false],
    [{ $or: [{ a: 9 }, { b: 'x' }] }, true], [{ $or: [{ a: 9 }, { b: 'z' }] }, false], [{ d: { $lt: new Date(2027, 0, 1) } }, true],
    [{ a: { $gt: 'text' } }, false], // BSON type bracketing: a number is never greater than a string
  ])('%j -> %s', (filter, expected) => {
    expect(matches(doc, filter)).toBe(expected);
  });

  test('ObjectId and its hex string are the same id in find-style filters', () => {
    const id = oid();
    expect(matches({ _id: id }, { _id: String(id) })).toBe(true);
    expect(matches({ _id: String(id) }, { _id: id })).toBe(true);
    expect(matches({ _id: id }, { _id: { $in: [String(id)] } })).toBe(true);
  });

  test('unsupported operators fail loudly instead of being ignored', () => {
    expect(() => matches(doc, { a: { $regex: 'x' } })).toThrow(/unsupported/);
    expect(() => matches(doc, { $where: 'true' })).toThrow(/unsupported/);
  });
});

describe('aggregation is strict about types (no automatic id casting)', () => {
  test('an ObjectId filter does not match a hex string and vice versa', async () => {
    const kit = makeKit();
    kit.orders.seed([{ workspaceId: WS, customer: oid(), status: 'delivered' }]);
    expect(await kit.orders.aggregate([{ $match: { workspaceId: WS } }])).toHaveLength(1);
    expect(await kit.orders.aggregate([{ $match: { workspaceId: String(WS) } }])).toHaveLength(0);
  });

  test('$group with $max / $sum and a compound _id', async () => {
    const kit = makeKit();
    const c1 = oid();
    const c2 = oid();
    kit.orders.seed([
      { workspaceId: WS, customer: c1, createdAt: new Date(2026, 0, 1) },
      { workspaceId: WS, customer: c1, createdAt: new Date(2026, 5, 1) },
      { workspaceId: WS, customer: c2, createdAt: new Date(2026, 2, 1) },
    ]);
    const rows = await kit.orders.aggregate([{ $group: { _id: '$customer', last: { $max: '$createdAt' } } }]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => String(r._id) === String(c1)).last).toEqual(new Date(2026, 5, 1));
    const counted = await kit.orders.aggregate([{ $group: { _id: { who: '$customer' }, n: { $sum: 1 } } }]);
    expect(counted.map((r) => r.n).sort()).toEqual([1, 2]);
  });
});

describe('schema-backed collections', () => {
  test('creation validates the real schema (enum + required)', async () => {
    const kit = makeKit();
    await expect(kit.sends.create({ workspaceId: WS, campaignId: oid(), customerId: oid(), phone: '1', status: 'nonsense' })).rejects.toThrow();
    await expect(kit.sends.create({ workspaceId: WS, campaignId: oid(), customerId: oid() })).rejects.toThrow(/phone/);
    const ok = await kit.sends.create({ workspaceId: WS, campaignId: oid(), customerId: oid(), phone: '966500000001' });
    expect(ok.status).toBe('queued');
  });

  test('$set of a path the schema does not know is rejected (Mongoose would drop it silently)', async () => {
    const kit = makeKit();
    const [row] = await kit.sends.insertMany([{ workspaceId: WS, campaignId: oid(), customerId: oid(), phone: '966500000001' }]);
    await expect(kit.sends.updateOne({ _id: row._id }, { $set: { nonsense: 1 } })).rejects.toThrow(/no path/);
    await expect(kit.sends.updateOne({ _id: row._id }, { $set: { status: 'sent', wamid: undefined } })).rejects.toThrow(/undefined/);
    await expect(kit.sends.updateOne({ _id: row._id }, { $set: { status: 'bogus' } })).rejects.toThrow(/not allowed/);
    await kit.sends.updateOne({ _id: row._id }, { $set: { status: 'sent', wamid: 'w1' } });
    expect(kit.sends.docs[0].status).toBe('sent');
  });

  test('unique (campaignId, customerId): insertMany ordered:false inserts the rest and reports 11000', async () => {
    const kit = makeKit();
    const campaignId = oid();
    const a = oid();
    const b = oid();
    await kit.sends.insertMany([{ workspaceId: WS, campaignId, customerId: a, phone: '966500000001' }]);
    let error;
    try {
      await kit.sends.insertMany([
        { workspaceId: WS, campaignId, customerId: a, phone: '966500000001' },
        { workspaceId: WS, campaignId, customerId: b, phone: '966500000002' },
      ], { ordered: false });
    } catch (err) { error = err; }
    expect(error.code).toBe(11000);
    expect(error.writeErrors).toEqual([{ index: 0, code: 11000 }]);
    expect(kit.sends.docs).toHaveLength(2);
  });

  test('sparse unique wamid on CampaignMessage', async () => {
    const kit = makeKit();
    const base = { workspaceId: WS, kind: 'promotion', customer: oid(), phone: '966500000001' };
    await kit.messages.create({ ...base, wamid: 'w1' });
    await kit.messages.create({ ...base });
    await kit.messages.create({ ...base });
    await expect(kit.messages.create({ ...base, wamid: 'w1' })).rejects.toMatchObject({ code: 11000 });
  });

  test('findOneAndUpdate is a compare-and-set: the second claim gets null', async () => {
    const kit = makeKit();
    const [c] = kit.campaigns.seed([{ workspaceId: WS, name: 'x', templateId: oid(), status: 'draft' }]);
    const claim = () => kit.campaigns.findOneAndUpdate({ _id: c._id, workspaceId: WS, status: 'draft' }, { $set: { status: 'sending' }, $inc: { runAttempts: 1 } }, { returnDocument: 'after' }).lean();
    const first = await claim();
    const second = await claim();
    expect(first.status).toBe('sending');
    expect(first.runAttempts).toBe(1);
    expect(second).toBeNull();
  });

  test('there is no way to delete anything', () => {
    const kit = makeKit();
    for (const name of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'remove', 'drop', 'findByIdAndDelete', 'bulkWrite']) {
      expect(kit.sends[name]).toBeUndefined();
    }
  });

  test('projection keeps only the selected fields (plus _id)', async () => {
    const kit = makeKit();
    kit.customers.seed([{ workspaceId: WS, firstname: 'A', lastname: 'B', phone: '966500000001', marketingConsent: true }]);
    const [row] = await kit.customers.find({ workspaceId: WS }).select('firstname').lean();
    expect(Object.keys(row).sort()).toEqual(['_id', 'firstname']);
    expect(await kit.customers.countDocuments({ workspaceId: OTHER })).toBe(0);
  });

  test('injected faults fire the requested number of times', async () => {
    const kit = makeKit();
    kit.fail('localizedsends', 'create', Object.assign(new Error('boom'), { code: 16500 }), 1);
    await expect(kit.sends.create({ workspaceId: WS, campaignId: oid(), customerId: oid(), phone: '966500000001' })).rejects.toThrow('boom');
    await expect(kit.sends.create({ workspaceId: WS, campaignId: oid(), customerId: oid(), phone: '966500000001' })).resolves.toBeTruthy();
  });
});
