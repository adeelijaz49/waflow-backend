// Unit tests for H1 (shared/localization/samePhone.js): a STOP opts out every record of the same workspace with the same
// normalised number. In-memory fakes only (the Customer fake honours the filters it is given); consent.js is replaced by a
// recorder that, like the real function, logs the event BEFORE mutating the record.
const { FakeModel, oid } = require('./helpers/fakeMongo');
const { optOutSamePhone, phoneKeys, sameNumber, spellingVariants, MAX_SCAN, SCAN_COOLDOWN_MS, _resetForTests } = require('../../shared/localization/samePhone');

beforeEach(() => { _resetForTests(); }); // the scan cooldown / too-large marker are process-local state

const WS = oid(0xa1);
const OTHER_WS = oid(0xb2);
const RLM = '\u{200F}';
const LRM = '\u{200E}';

class FakeCustomers extends FakeModel {
  async updateOne(filter, update) {
    this.record('updateOne', filter, { update });
    const doc = this.docs.find((d) => Object.entries(filter).every(([k, v]) => String(d[k]) === String(v)));
    if (doc) Object.assign(doc, update.$set || {});
    return { matchedCount: doc ? 1 : 0 };
  }
}

function setup(rows, { settings = { defaultCountryCode: '966' }, failures = {}, maxScan } = {}) {
  const customers = new FakeCustomers(rows.map((r, i) => ({ _id: oid(100 + i), workspaceId: WS, optedOut: false, ...r })));
  const events = [];
  const writes = { attempts: {} };
  const deps = {
    Customer: customers,
    Settings: { findOne: () => ({ select: () => ({ lean: async () => settings }) }) },
    consent: {
      async withdrawMarketingConsent({ customer, method, source, workspaceId }) {
        const key = String(customer._id);
        writes.attempts[key] = (writes.attempts[key] || 0) + 1;
        events.push({ type: 'consent_withdrawn', customerId: key, phone: customer.phone, method, source, workspaceId: String(workspaceId) });
        const f = failures[key];
        if (f && writes.attempts[key] <= f.times) throw f.error;
        const doc = customers.docs.find((d) => String(d._id) === key);
        doc.optedOut = true; doc.optedOutAt = new Date();
      },
    },
    sleep: async () => {},
    log: jest.fn(),
    maxScan,
  };
  return { deps, customers, events, writes, byIdx: (i) => customers.docs[i] };
}

const run = (deps, args) => optOutSamePhone({ workspaceId: WS, from: '966501234567', method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply', ...args }, deps);

describe('phone matching', () => {
  const cases = [
    ['966501234567', true], ['+966501234567', true], ['+966 50 123 4567', true], ['00966501234567', true], ['(966) 50-123-4567', true],
    ['٩٦٦٥٠١٢٣٤٥٦٧', true], ['+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧', true], ['0501234567', true], [`${RLM}+966501234567`, true], [`${LRM}966 50 123 4567${LRM}`, true],
    ['966501234568', false], ['12345', false], ['', false], [null, false], [undefined, false], ['deleted-64b64b64b64b64b64b64b64', false], ['+61 412 345 678', false],
  ];
  test.each(cases)('%j -> %s', (stored, want) => { expect(sameNumber('966501234567', stored, '966')).toBe(want); });
  test('a workspace whose default country code is 61: a local 04.. number does not match a 966 sender, but matches an AU one', () => {
    expect(sameNumber('966501234567', '0412345678', '61')).toBe(false);
    expect(sameNumber('61412345678', '0412345678', '61')).toBe(true);
  });
  test('phoneKeys of junk is empty', () => { expect(phoneKeys('abc', '966').size).toBe(0); expect(phoneKeys(null, '966').size).toBe(0); });
});

describe('optOutSamePhone', () => {
  test('opts out every other record of the number in any stored format, one ConsentEvent each, never the primary', async () => {
    const s = setup([
      { phone: '966501234567' },        // 0: the primary (what findOne({phone: from}) found)
      { phone: '+966 50 123 4567' },    // 1
      { phone: '0501234567' },          // 2
      { phone: '٩٦٦٥٠١٢٣٤٥٦٧' },        // 3 Arabic-Indic
      { phone: `${RLM}+966501234567` }, // 4 direction mark
      { phone: '966509999999' },        // 5 other number
    ]);
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(res).toEqual({ matched: 4, optedOut: 4, failed: 0 });
    expect([1, 2, 3, 4].every((i) => s.byIdx(i).optedOut === true)).toBe(true);
    expect(s.byIdx(0).optedOut).toBe(false); // the primary is the caller's business
    expect(s.byIdx(5).optedOut).toBe(false);
    expect(s.events).toHaveLength(4);
    expect(new Set(s.events.map((e) => e.customerId)).size).toBe(4);
    s.events.forEach((e) => { expect(e.method).toBe('whatsapp_stop_command'); expect(e.source).toBe('WhatsApp STOP reply (same number, other customer record)'); expect(e.workspaceId).toBe(WS); });
  });
  test('no primary record (null): every matching record is a sibling', async () => {
    const s = setup([{ phone: '+966501234567' }, { phone: '966501234567' }]);
    expect(await run(s.deps, { exceptCustomerId: null })).toEqual({ matched: 2, optedOut: 2, failed: 0 });
    expect(await run(s.deps, { exceptCustomerId: undefined })).toEqual({ matched: 0, optedOut: 0, failed: 0 }); // idempotent
  });
  test('already opted-out records are skipped; demo records are included; erased records are excluded', async () => {
    const s = setup([
      { phone: '966501234567' },
      { phone: '+966501234567', optedOut: true },
      { phone: '+966 50 123 4567', isDemo: true },
      { phone: '966501234567', deletedAt: new Date(), deletionReason: 'erasure' },
    ]);
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(res).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect(s.byIdx(2).optedOut).toBe(true);
    expect(s.byIdx(3).optedOut).toBe(false);
  });
  test('other workspaces are never touched, and the read is workspace-scoped', async () => {
    const s = setup([{ phone: '966501234567' }, { phone: '+966501234567', workspaceId: OTHER_WS }, { phone: '0501234567' }]);
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(res.optedOut).toBe(1);
    expect(s.byIdx(1).optedOut).toBe(false);
    expect(s.customers.calls.filter((c) => c.method === 'find').every((c) => String(c.filter.workspaceId) === WS)).toBe(true);
  });
  test('the default country code of the workspace decides what a local number means', async () => {
    const s = setup([{ phone: '0412345678' }], { settings: { defaultCountryCode: '61' } });
    expect(await run(s.deps, { from: '61412345678' })).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    const t = setup([{ phone: '0412345678' }], { settings: { defaultCountryCode: '966' } });
    expect(await run(t.deps, { from: '61412345678' })).toEqual({ matched: 0, optedOut: 0, failed: 0 });
  });
  test('a write failure is retried once; a second failure is logged and counted, the others still run', async () => {
    const s = setup([{ phone: '+966501234567' }, { phone: '0501234567' }, { phone: '966 50 123 4567' }], { failures: {} });
    const flaky = s.byIdx(0)._id; const dead = s.byIdx(1)._id;
    const s2 = setup([{ phone: '+966501234567' }, { phone: '0501234567' }, { phone: '966 50 123 4567' }], { failures: { [flaky]: { times: 1, error: new Error('429') }, [dead]: { times: 5, error: new Error('down') } } });
    const res = await run(s2.deps, {});
    expect(res).toEqual({ matched: 3, optedOut: 2, failed: 1 });
    expect(s2.writes.attempts[flaky]).toBe(2);
    expect(s2.writes.attempts[dead]).toBe(2);
    expect(s2.deps.log.mock.calls.some((c) => /SAME-NUMBER OPT-OUT FAILED/.test(String(c[0])))).toBe(true);
    expect(s.deps).toBeTruthy();
  });
  test('a Mongoose ValidationError on save (legacy record) falls back to a direct flag update, with the event already logged', async () => {
    const probe = setup([{ phone: '+966501234567' }]);
    const id0 = probe.byIdx(0)._id;
    const err = Object.assign(new Error('lastname required'), { name: 'ValidationError' });
    const s = setup([{ phone: '+966501234567' }], { failures: { [id0]: { times: 9, error: err } } });
    expect(await run(s.deps, {})).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect(s.byIdx(0).optedOut).toBe(true);
    expect(s.writes.attempts[id0]).toBe(1); // no retry for a validation error, so exactly one ConsentEvent
    expect(s.customers.calls.some((c) => c.method === 'updateOne')).toBe(true);
  });
  test('above the scan cap the full scan is skipped, the exact spellings (incl. the national forms) are still opted out, one warning per hour', async () => {
    const s = setup([{ phone: '966501234567' }, { phone: '+966501234567' }, { phone: '0501234567' }, { phone: '501234567' }, { phone: '+966 50 123 4567' }, { phone: '966509999999' }], { maxScan: 2 });
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    const variantFinds = s.customers.calls.filter((c) => c.method === 'find' && c.filter && c.filter.phone);
    expect(variantFinds).toHaveLength(1);
    expect(variantFinds[0].filter.phone.$in).toEqual(expect.arrayContaining(['966501234567', '+966501234567', '00966501234567', '0501234567', '501234567']));
    expect(res).toEqual({ matched: 3, optedOut: 3, failed: 0 }); // +966..., 05..., bare national; the spaced spelling needs the scan
    expect(s.byIdx(4).optedOut).toBe(false);
    const scans = () => s.customers.calls.filter((c) => c.method === 'find' && c.filter && !c.filter.phone && !c.filter._id).length;
    expect(scans()).toBe(1);
    expect(s.deps.log.mock.calls.filter((c) => /more than 2 customers/.test(String(c[0])))).toHaveLength(1);
    // another number of the same workspace within the hour: no second scan read, no second warning
    await run(s.deps, { from: '966501230000', exceptCustomerId: null });
    expect(scans()).toBe(1);
    expect(s.deps.log.mock.calls.filter((c) => /more than 2 customers/.test(String(c[0])))).toHaveLength(1);
    // after the hour the workspace is looked at (and logged) again
    s.deps.now = () => Date.now() + 61 * 60 * 1000;
    await run(s.deps, { from: '966501230000', exceptCustomerId: null });
    expect(scans()).toBe(2);
    expect(s.deps.log.mock.calls.filter((c) => /more than 2 customers/.test(String(c[0])))).toHaveLength(2);
  });
  test('the scan cap is 20,000 rows', () => { expect(MAX_SCAN).toBe(20000); expect(SCAN_COOLDOWN_MS).toBe(60 * 1000); });
  test('the cheap exact-spelling query runs FIRST and its siblings are opted out before the scan is read', async () => {
    const s = setup([{ phone: '966501234567' }, { phone: '0501234567' }, { phone: '+966 50 123 4567' }]);
    const order = [];
    const realFind = s.customers.find.bind(s.customers);
    s.customers.find = (filter = {}) => { order.push(filter.phone ? 'variants' : filter._id ? 'hydrate' : 'scan'); return realFind(filter); };
    const realWithdraw = s.deps.consent.withdrawMarketingConsent;
    s.deps.consent.withdrawMarketingConsent = async (a) => { order.push(`withdraw:${a.customer.phone}`); return realWithdraw(a); };
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(res).toEqual({ matched: 2, optedOut: 2, failed: 0 });
    expect(order).toEqual(['variants', 'hydrate', 'withdraw:0501234567', 'scan', 'hydrate', 'withdraw:+966 50 123 4567']);
  });
  test('a sibling found by the cheap query is never opted out twice when the scan sees it too', async () => {
    const s = setup([{ phone: '966501234567' }, { phone: '+966501234567' }]);
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(res).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect(s.events).toHaveLength(1);
  });
  test('a failing fallback scan never loses the siblings the cheap query already opted out', async () => {
    const s = setup([{ phone: '966501234567' }, { phone: '+966501234567' }, { phone: '+966 50 123 4567' }]);
    const realFind = s.customers.find.bind(s.customers);
    s.customers.find = (filter = {}) => { if (!filter.phone && !filter._id) throw new Error('scan timeout'); return realFind(filter); };
    const res = await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(res).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect(s.byIdx(1).optedOut).toBe(true);
    expect(s.deps.log.mock.calls.some((c) => /fallback scan failed/.test(String(c[0])))).toBe(true);
  });
  test('cooldown: one scan per (workspace, normalised phone) per 60 s; other numbers and workspaces are independent; it expires', async () => {
    let clock = 1000000;
    const s = setup([{ phone: '966501234567' }, { phone: '+966 50 123 4567' }, { phone: '966507777777' }, { phone: '+966 50 777 7777' }]);
    s.deps.now = () => clock;
    const scans = () => s.customers.calls.filter((c) => c.method === 'find' && c.filter && !c.filter.phone && !c.filter._id).length;
    await run(s.deps, { exceptCustomerId: s.byIdx(0)._id });
    expect(scans()).toBe(1);
    expect(s.byIdx(1).optedOut).toBe(true);
    // the same number again (a forged repeat): the odd spelling is not rescanned, nothing is read in bulk
    s.byIdx(1).optedOut = false;
    clock += 30 * 1000;
    expect(await run(s.deps, { exceptCustomerId: s.byIdx(0)._id })).toEqual({ matched: 0, optedOut: 0, failed: 0 });
    expect(scans()).toBe(1);
    // a different number of the same workspace scans on its own
    await run(s.deps, { from: '966507777777', exceptCustomerId: s.byIdx(2)._id });
    expect(scans()).toBe(2);
    expect(s.byIdx(3).optedOut).toBe(true);
    // the first number after the cooldown: scanned again
    clock += 31 * 1000;
    expect(await run(s.deps, { exceptCustomerId: s.byIdx(0)._id })).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect(scans()).toBe(3);
    // the same number in another workspace is its own key
    await optOutSamePhone({ workspaceId: OTHER_WS, from: '966501234567', method: 'm', source: 's' }, s.deps);
    expect(scans()).toBe(4);
  });
  test('the cooldown map is bounded: more than 5,000 distinct numbers do not grow it without limit and nothing throws', async () => {
    const s = setup([{ phone: '966501234567' }]);
    for (let i = 0; i < 5100; i += 1) {
      const res = await optOutSamePhone({ workspaceId: WS, from: String(966500000000 + i), method: 'm', source: 's' }, s.deps);
      expect(res.failed).toBe(0);
    }
    expect(s.deps.log).not.toHaveBeenCalled();
  });
  test('spellingVariants: international, +, 00, national forms and the raw text; no national forms without a country code', () => {
    expect(spellingVariants('+966 50 123 4567', new Set(['966501234567']), '966').sort()).toEqual(['+966 50 123 4567', '+966501234567', '00966501234567', '0501234567', '501234567', '966501234567'].sort());
    expect(spellingVariants('966501234567', new Set(['966501234567']), '').sort()).toEqual(['+966501234567', '00966501234567', '966501234567'].sort());
    expect(phoneKeys('0501234567', '').size).toBe(0); // a local number is never guessed without a country code
  });
  test('never throws: database errors, junk arguments', async () => {
    const s = setup([{ phone: '966501234567' }]);
    s.customers.find = () => { throw new Error('db down'); };
    await expect(run(s.deps, {})).resolves.toEqual({ matched: 0, optedOut: 0, failed: 0 });
    await expect(optOutSamePhone({}, s.deps)).resolves.toEqual({ matched: 0, optedOut: 0, failed: 0 });
    await expect(optOutSamePhone({ workspaceId: WS, from: 'not a number' }, s.deps)).resolves.toEqual({ matched: 0, optedOut: 0, failed: 0 });
    await expect(optOutSamePhone(undefined, s.deps)).resolves.toEqual({ matched: 0, optedOut: 0, failed: 0 });
  });
  test('a number that is not on file twice changes nothing', async () => {
    const s = setup([{ phone: '966501234567' }, { phone: '966509999999' }]);
    expect(await run(s.deps, { exceptCustomerId: s.byIdx(0)._id })).toEqual({ matched: 0, optedOut: 0, failed: 0 });
    expect(s.events).toHaveLength(0);
  });
});
