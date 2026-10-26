// Unit tests for shared/promoDelivery.js (Meta's real error text, plain-language failure reasons, per-promotion delivery summary).
// No database: the models are mocked, so nothing here can touch real data.
jest.mock('../models/WhatsAppMessage', () => ({ distinct: jest.fn() }));
jest.mock('../models/CampaignMessage', () => ({ aggregate: jest.fn() }));
jest.mock('../models/Promotion', () => ({ findOne: jest.fn() }));

const CampaignMessage = require('../models/CampaignMessage');
const Promotion = require('../models/Promotion');
const { metaErrorInfo, describeFailure, getPromotionDelivery } = require('../shared/promoDelivery');

const metaError = (code, message, details) => Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: { error: { message, type: 'OAuthException', code, ...(details ? { error_data: { messaging_product: 'whatsapp', details } } : {}) } } },
});

let savedSwitch;
beforeEach(() => {
  savedSwitch = process.env.PROMO_DELIVERY_FIX;
  delete process.env.PROMO_DELIVERY_FIX;
  CampaignMessage.aggregate.mockReset();
  Promotion.findOne.mockReset();
});
afterEach(() => {
  if (savedSwitch === undefined) delete process.env.PROMO_DELIVERY_FIX; else process.env.PROMO_DELIVERY_FIX = savedSwitch;
});

describe('metaErrorInfo', () => {
  test("returns Meta's message and code from the error body", () => {
    expect(metaErrorInfo(metaError(133010, '(#133010) Account not registered'))).toEqual({ message: '(#133010) Account not registered', code: '133010', meta: true });
  });
  test('appends Meta\'s details when they add something', () => {
    const info = metaErrorInfo(metaError(131047, '(#131047) Re-engagement message', 'More than 24 hours have passed since the customer last replied.'));
    expect(info.code).toBe('131047');
    expect(info.meta).toBe(true);
    expect(info.message).toBe('(#131047) Re-engagement message - More than 24 hours have passed since the customer last replied.');
  });
  test('does not repeat details that the message already contains', () => {
    expect(metaErrorInfo(metaError(1, 'Boom: because', 'because')).message).toBe('Boom: because');
  });
  test('an error without a Meta body keeps its own message and has no code', () => {
    expect(metaErrorInfo(new Error('boom'))).toEqual({ message: 'boom' }); // no `meta` flag: callers keep their own wording
    expect(metaErrorInfo(Object.assign(new Error('socket hang up'), { response: { status: 502, data: '<html>' } }))).toEqual({ message: 'socket hang up' });
  });
  test('a null/undefined error does not throw', () => {
    expect(metaErrorInfo(undefined)).toEqual({ message: undefined });
    expect(metaErrorInfo(null)).toEqual({ message: undefined });
  });
  test('very long messages are cut to 400 characters', () => {
    expect(metaErrorInfo(metaError(9, 'x'.repeat(1000))).message).toHaveLength(400);
  });
  test('kill switch off: exactly the plain err.message, no code (the previous behaviour)', () => {
    process.env.PROMO_DELIVERY_FIX = 'off';
    expect(metaErrorInfo(metaError(133010, '(#133010) Account not registered'))).toEqual({ message: 'Request failed with status code 400' });
  });
});

describe('describeFailure', () => {
  test('131047 is the 24-hour window', () => {
    const d = describeFailure({ errorCode: '131047', statusReason: 'Re-engagement message' });
    expect(d.code).toBe('131047');
    expect(d.group).toBe('window');
    expect(d.label).toMatch(/24-hour window/);
  });
  test('rows written before the code was captured are recognised by Meta\'s title', () => {
    const d = describeFailure({ statusReason: 'Re-engagement message' });
    expect(d.code).toBe('131047');
    expect(d.group).toBe('window');
  });
  test('other known codes', () => {
    expect(describeFailure({ errorCode: '131049' }).group).toBe('marketing_limit');
    expect(describeFailure({ errorCode: '133010' }).group).toBe('not_registered');
    expect(describeFailure({ errorCode: '131030' }).group).toBe('allow_list');
    expect(describeFailure({ errorCode: '132015' }).group).toBe('template');
    expect(describeFailure({ errorCode: '131053' }).group).toBe('media');
    expect(describeFailure({ errorCode: '131026' }).group).toBe('undeliverable');
    expect(describeFailure({ errorCode: '131042' }).group).toBe('payment');
  });
  test('131049 does not claim more than Meta says (reason not disclosed); 133010 points at the sending number', () => {
    expect(describeFailure({ errorCode: '131049' }).label).toMatch(/does not say why/);
    expect(describeFailure({ errorCode: '133010' }).label).toMatch(/Your sending WhatsApp number/);
  });
  test('an unknown code keeps Meta\'s own text', () => {
    const d = describeFailure({ errorCode: '999999', statusReason: 'Something new' });
    expect(d).toEqual({ code: '999999', group: 'other', label: 'Refused by WhatsApp (code 999999): Something new' });
  });
  test('the old bare "failed with status code 400" text says the reason was not recorded', () => {
    expect(describeFailure({ statusReason: 'Request failed with status code 400' }).label).toMatch(/not recorded/);
    expect(describeFailure({ statusReason: 'Send failed' }).label).toMatch(/not recorded/);
    expect(describeFailure({}).label).toMatch(/not recorded/);
  });
});

describe('getPromotionDelivery', () => {
  const promoDoc = { _id: 'p1' };
  const found = (doc) => Promotion.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) });
  const group = (status, count, extra = {}) => ({ _id: { status, messageType: 'interactive', accepted: true, ...extra }, count });

  test('unknown / other-workspace promotion: throws Promotion not found', async () => {
    found(null);
    await expect(getPromotionDelivery({ promotionId: 'zzz', workspaceId: 'w1' })).rejects.toThrow('Promotion not found');
  });

  test('scopes the promotion lookup to the workspace', async () => {
    found(promoDoc); CampaignMessage.aggregate.mockResolvedValue([]);
    await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1' });
    expect(Promotion.findOne).toHaveBeenCalledWith({ _id: 'p1', workspaceId: 'w1' });
    await getPromotionDelivery({ promotionId: 'p1' });
    expect(Promotion.findOne).toHaveBeenLastCalledWith({ _id: 'p1' });
  });

  test('no rows: all zeros', async () => {
    found(promoDoc); CampaignMessage.aggregate.mockResolvedValue([]);
    const out = await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1' });
    expect(out).toEqual({
      promotionId: 'p1', since: null, total: 0, accepted: 0, delivered: 0, read: 0, waiting: 0, failed: 0,
      rejectedImmediately: 0, failedAfterAccepted: 0, viaTemplate: 0, failures: [],
    });
  });

  test('counts accepted / delivered / read / waiting / failed and explains the failures', async () => {
    found(promoDoc);
    CampaignMessage.aggregate.mockResolvedValue([
      group('read', 3),
      group('delivered', 2),
      group('sent', 1),
      group('failed', 2, { errorCode: '131047', statusReason: 'Re-engagement message' }),
      group('failed', 1, { errorCode: '131047', statusReason: 'Re-engagement message', messageType: 'template' }),
      group('failed', 4, { accepted: false, statusReason: 'Request failed with status code 400' }),
      group('failed', 1, { accepted: false, errorCode: '133010', statusReason: '(#133010) Account not registered' }),
    ]);
    const out = await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1' });
    expect(out).toMatchObject({
      total: 14, accepted: 9, delivered: 5, read: 3, waiting: 1, failed: 8, rejectedImmediately: 5, failedAfterAccepted: 3, viaTemplate: 1,
    });
    // the two 131047 groups (chat-style + template) merge into one reason, biggest first
    expect(out.failures.map((f) => [f.code, f.count])).toEqual([['', 4], ['131047', 3], ['133010', 1]]);
    expect(out.failures.find((f) => f.code === '131047').group).toBe('window');
    expect(out.failures.find((f) => f.code === '133010').group).toBe('not_registered');
  });

  test('"since" limits the rows to one send (createdAt >= since) and is echoed back', async () => {
    found(promoDoc); CampaignMessage.aggregate.mockResolvedValue([]);
    const since = new Date(Date.UTC(2026, 9, 25, 15, 38, 0));
    const out = await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1', since });
    expect(CampaignMessage.aggregate.mock.calls[0][0][0]).toEqual({ $match: { promotion: 'p1', kind: 'promotion', createdAt: { $gte: since } } });
    expect(out.since).toBe(since.toISOString());
  });

  test('different reasons stay separate lines (different codes, or different code-less texts), the same reason merges', async () => {
    found(promoDoc);
    CampaignMessage.aggregate.mockResolvedValue([
      group('failed', 1, { accepted: false, statusReason: 'socket hang up' }),
      group('failed', 2, { accepted: false, statusReason: 'Request failed with status code 400' }),
      group('failed', 3, { accepted: false, statusReason: 'Request failed with status code 502' }), // same generic label as the 400 row: merges
      group('failed', 4, { errorCode: '999991', statusReason: 'New thing A' }),
      group('failed', 5, { errorCode: '999992', statusReason: 'New thing B' }),
    ]);
    const out = await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1' });
    expect(out.failures.map((f) => [f.code, f.count])).toEqual([['', 5], ['999992', 5], ['999991', 4], ['', 1]].sort((a, b) => b[1] - a[1]));
    expect(out.failures).toHaveLength(4);
    expect(out.failures.find((f) => f.code === '999991').label).toMatch(/New thing A/);
    expect(out.failures.find((f) => f.code === '999992').label).toMatch(/New thing B/);
    expect(out.failures.find((f) => f.label.includes('socket hang up'))).toMatchObject({ count: 1 });
  });

  test('viaTemplate counts only templates WhatsApp ACCEPTED (a template refused outright was never sent)', async () => {
    found(promoDoc);
    CampaignMessage.aggregate.mockResolvedValue([
      group('read', 2, { messageType: 'template' }),
      group('sent', 1, { messageType: 'template' }),
      group('failed', 3, { messageType: 'template', accepted: false, errorCode: '132015', statusReason: '(#132015) Template is paused' }),
      group('read', 4, { messageType: 'interactive' }),
    ]);
    const out = await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1' });
    expect(out.viaTemplate).toBe(3);
    expect(out.total).toBe(10);
  });

  test('an invalid "since" is ignored (whole promotion)', async () => {
    found(promoDoc); CampaignMessage.aggregate.mockResolvedValue([]);
    await getPromotionDelivery({ promotionId: 'p1', workspaceId: 'w1', since: new Date('nope') });
    expect(CampaignMessage.aggregate.mock.calls[0][0][0]).toEqual({ $match: { promotion: 'p1', kind: 'promotion' } });
  });
});
