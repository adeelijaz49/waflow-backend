// Unit tests for C3 (shared/localization/statusErrors.js): the reader of CampaignMessage.errorCode + the code classifier.
const mockRows = [];
const mockCalls = [];
jest.mock('../../models/CampaignMessage', () => ({
  find: (filter) => {
    mockCalls.push(filter);
    const rows = mockRows.filter((r) => String(r.workspaceId) === String(filter.workspaceId) && filter.wamid.$in.includes(r.wamid));
    const q = { select: () => q, lean: async () => rows };
    return q;
  },
}));

const { getMessageErrors, describeMetaError } = require('../../shared/localization/statusErrors');

const WS = '000000000000000000000001';
const OTHER = '000000000000000000000002';

beforeEach(() => {
  mockRows.length = 0; mockCalls.length = 0;
  mockRows.push(
    { workspaceId: WS, wamid: 'w1', status: 'failed', errorCode: '131049', statusReason: 'This message was not delivered to maintain healthy ecosystem engagement.' },
    { workspaceId: WS, wamid: 'w2', status: 'delivered' },
    { workspaceId: WS, wamid: 'w3', status: 'failed', statusReason: 'old row without a code' },
    { workspaceId: OTHER, wamid: 'w4', status: 'failed', errorCode: '132001' },
  );
});

describe('getMessageErrors', () => {
  test('returns status, code and reason per wamid, workspace-scoped', async () => {
    const map = await getMessageErrors(WS, ['w1', 'w2', 'w3', 'w4', 'unknown']);
    expect([...map.keys()].sort()).toEqual(['w1', 'w2', 'w3']); // w4 belongs to another workspace
    expect(map.get('w1')).toEqual({ status: 'failed', errorCode: '131049', statusReason: 'This message was not delivered to maintain healthy ecosystem engagement.' });
    expect(map.get('w2')).toEqual({ status: 'delivered', errorCode: null, statusReason: null });
    expect(map.get('w3').errorCode).toBeNull(); // rows written before C3 have no code
    expect(mockCalls.every((f) => String(f.workspaceId) === WS)).toBe(true);
  });
  test('chunks by 1000 wamids and de-duplicates', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `x${i}`).concat(['w1', 'w1']);
    await getMessageErrors(WS, ids);
    expect(mockCalls).toHaveLength(3);
    expect(mockCalls[0].wamid.$in).toHaveLength(1000);
  });
  test('never throws: bad input or a database error gives an empty map', async () => {
    expect((await getMessageErrors(undefined, ['w1'])).size).toBe(0);
    expect((await getMessageErrors(WS, null)).size).toBe(0);
    expect((await getMessageErrors(WS, [1, null, '', {}])).size).toBe(0);
    const CampaignMessage = require('../../models/CampaignMessage');
    const orig = CampaignMessage.find; CampaignMessage.find = () => { throw new Error('boom'); };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await getMessageErrors(WS, ['w1'])).size).toBe(0); } finally { CampaignMessage.find = orig; console.error.mockRestore(); }
  });
});

describe('describeMetaError', () => {
  test.each([
    ['132000', 'template', false], [132001, 'template', false], ['132012', 'template', false], ['132015', 'template', false], ['132016', 'template', false], ['132018', 'template', false],
    ['131049', 'marketing_limit', true], ['131047', 'window', false], ['131026', 'other', false], ['999', 'other', false],
    [null, 'none', false], [undefined, 'none', false], ['', 'none', false],
  ])('%j -> %s (retryable %s)', (code, group, retryable) => { expect(describeMetaError(code)).toEqual({ group, retryable }); });
});
