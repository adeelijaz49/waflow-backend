// Unit tests for shared/promoWindow.js (the "has this customer written to us in the last 24 hours?" lookup).
// No database: the WhatsAppMessage model is mocked, so nothing here can touch real data.
jest.mock('../models/WhatsAppMessage', () => ({ distinct: jest.fn() }));

const WhatsAppMessage = require('../models/WhatsAppMessage');
const promoWindow = require('../shared/promoWindow');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 16, 0, 0);

let savedSwitch;
beforeEach(() => {
  savedSwitch = process.env.PROMO_DELIVERY_FIX;
  delete process.env.PROMO_DELIVERY_FIX;
  WhatsAppMessage.distinct.mockReset();
});
afterEach(() => {
  if (savedSwitch === undefined) delete process.env.PROMO_DELIVERY_FIX; else process.env.PROMO_DELIVERY_FIX = savedSwitch;
});

describe('phoneKey', () => {
  test('keeps digits only and drops a leading 00 international prefix', () => {
    expect(promoWindow.phoneKey('+61 412 345 678')).toBe('61412345678');
    expect(promoWindow.phoneKey('0061412345678')).toBe('61412345678');
    expect(promoWindow.phoneKey('61412345678')).toBe('61412345678');
    expect(promoWindow.phoneKey('(966) 55-123-4567')).toBe('966551234567');
  });
  test('a local-format number stays local (it will not match WhatsApp\'s from, which is the safe side)', () => {
    expect(promoWindow.phoneKey('0412345678')).toBe('0412345678');
  });
  test('empty / missing values give an empty key', () => {
    expect(promoWindow.phoneKey(null)).toBe('');
    expect(promoWindow.phoneKey(undefined)).toBe('');
    expect(promoWindow.phoneKey('')).toBe('');
  });
});

describe('enabled (kill switch PROMO_DELIVERY_FIX)', () => {
  test('on by default and for any other value', () => {
    expect(promoWindow.enabled()).toBe(true);
    for (const v of ['on', '1', 'true', 'yes', 'anything']) { process.env.PROMO_DELIVERY_FIX = v; expect(promoWindow.enabled()).toBe(true); }
  });
  test('off for off / 0 / false / no, any case, with spaces', () => {
    for (const v of ['off', 'OFF', ' Off ', '0', 'false', 'FALSE', 'no']) { process.env.PROMO_DELIVERY_FIX = v; expect(promoWindow.enabled()).toBe(false); }
  });
});

describe('insideWindow', () => {
  test('kill switch off: no answer and no database call at all', async () => {
    process.env.PROMO_DELIVERY_FIX = 'off';
    expect(await promoWindow.insideWindow({ phones: ['61412345678'], workspaceId: 'w1', now: NOW })).toBeNull();
    expect(WhatsAppMessage.distinct).not.toHaveBeenCalled();
  });

  test('no phones: an empty answer without a database call', async () => {
    const out = await promoWindow.insideWindow({ phones: [null, '', undefined], workspaceId: 'w1', now: NOW });
    expect(out).toEqual(new Set());
    expect(WhatsAppMessage.distinct).not.toHaveBeenCalled();
  });

  test('queries only inbound messages of that workspace, by digit-normalised de-duplicated phones, since 23 hours ago', async () => {
    WhatsAppMessage.distinct.mockResolvedValue(['61412345678']);
    const out = await promoWindow.insideWindow({ phones: ['+61 412 345 678', '0061412345678', '966551234567'], workspaceId: 'w1', now: NOW });
    expect(WhatsAppMessage.distinct).toHaveBeenCalledTimes(1);
    const [field, filter] = WhatsAppMessage.distinct.mock.calls[0];
    expect(field).toBe('phone');
    expect(filter.direction).toBe('inbound');
    expect(filter.workspaceId).toBe('w1');
    expect(filter.phone.$in.sort()).toEqual(['61412345678', '966551234567']);
    const cutoff = new Date(NOW - 24 * HOUR + HOUR);
    expect(filter.$or[0]).toEqual({ receivedAt: { $gte: cutoff } });
    expect(filter.$or[1]).toEqual({ receivedAt: null, createdAt: { $gte: cutoff } });
    expect(out).toEqual(new Set(['61412345678']));
  });

  test('the answer is keyed like phoneKey, so a customer stored as "+61 412 345 678" matches WhatsApp\'s 61412345678', async () => {
    WhatsAppMessage.distinct.mockResolvedValue(['61412345678']);
    const out = await promoWindow.insideWindow({ phones: ['+61 412 345 678', '0412345678'], workspaceId: 'w1', now: NOW });
    expect(out.has(promoWindow.phoneKey('+61 412 345 678'))).toBe(true);
    expect(out.has(promoWindow.phoneKey('0412345678'))).toBe(false);
  });

  test('no workspace id: no workspace condition (legacy single-tenant callers)', async () => {
    WhatsAppMessage.distinct.mockResolvedValue([]);
    await promoWindow.insideWindow({ phones: ['61412345678'], now: NOW });
    expect(WhatsAppMessage.distinct.mock.calls[0][1]).not.toHaveProperty('workspaceId');
  });

  test('a large audience is looked up in chunks of 500 phones', async () => {
    WhatsAppMessage.distinct.mockResolvedValueOnce(['61400000001']).mockResolvedValueOnce(['61400000900']);
    const phones = Array.from({ length: 1000 }, (_, i) => `614${String(i + 1).padStart(8, '0')}`);
    const out = await promoWindow.insideWindow({ phones, workspaceId: 'w1', now: NOW });
    expect(WhatsAppMessage.distinct).toHaveBeenCalledTimes(2);
    expect(WhatsAppMessage.distinct.mock.calls[0][1].phone.$in).toHaveLength(500);
    expect(WhatsAppMessage.distinct.mock.calls[1][1].phone.$in).toHaveLength(500);
    expect(out).toEqual(new Set(['61400000001', '61400000900']));
  });

  test('a failed lookup gives no answer (null) so the caller keeps the previous behaviour, and never throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    WhatsAppMessage.distinct.mockRejectedValue(new Error('db down'));
    await expect(promoWindow.insideWindow({ phones: ['61412345678'], workspaceId: 'w1', now: NOW })).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
