'use strict';
const { waitMs, waitForWindow, MAX_PER_HOUR, MAX_PER_DAY, HOUR_MS, DAY_MS } = require('../shared/otpLockout');

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms);
const row = (attempts, msAgo) => ({ attempts, createdAt: ago(msAgo) });
const MIN = 60 * 1000;

// a model that answers like LoginChallenge.find(...).select(...).lean()
function modelOf(rows) {
  const calls = [];
  return {
    calls,
    find: (filter) => { calls.push(filter); return { select: () => ({ lean: async () => rows }) }; },
  };
}

describe('waitForWindow: how long until the wrong guesses in a window fall below the limit', () => {
  test('under the limit: 0', () => {
    expect(waitForWindow([row(5, 10 * MIN), row(4, 20 * MIN)], HOUR_MS, 10, NOW)).toBe(0);
  });
  test('at the limit: wait until the OLDEST code that is needed to get under it leaves the window', () => {
    // 5 + 5 = 10 (the limit). Dropping the oldest (5, 50 min ago) gets it to 5: that one leaves the hour in 10 minutes.
    expect(waitForWindow([row(5, 50 * MIN), row(5, 5 * MIN)], HOUR_MS, 10, NOW)).toBe(10 * MIN);
  });
  test('several codes: only as many as needed are waited out', () => {
    // 4 + 4 + 4 = 12; dropping the oldest (4, 55 min ago) leaves 8 < 10 -> 5 minutes
    expect(waitForWindow([row(4, 55 * MIN), row(4, 30 * MIN), row(4, 1 * MIN)], HOUR_MS, 10, NOW)).toBe(5 * MIN);
  });
  test('codes older than the window do not count at all', () => {
    expect(waitForWindow([row(5, 2 * HOUR_MS), row(5, 3 * HOUR_MS), row(5, 10 * MIN)], HOUR_MS, 10, NOW)).toBe(0);
  });
  test('rows without a usable attempts count are zero, never NaN', () => {
    expect(waitForWindow([{ createdAt: ago(MIN) }, { attempts: 'x', createdAt: ago(MIN) }, { attempts: null, createdAt: ago(MIN) }], HOUR_MS, 1, NOW)).toBe(0);
  });
  test('the order the database returns the rows in does not matter', () => {
    const rows = [row(5, 5 * MIN), row(5, 50 * MIN)];
    expect(waitForWindow(rows, HOUR_MS, 10, NOW)).toBe(10 * MIN);
    expect(waitForWindow([...rows].reverse(), HOUR_MS, 10, NOW)).toBe(10 * MIN);
  });
});

describe('waitMs: the cumulative limit on wrong login-code guesses for one number', () => {
  test('limits are the documented ones', () => {
    expect([MAX_PER_HOUR, MAX_PER_DAY]).toEqual([10, 30]);
  });

  test('looks only at this contact and method, over the last 24 hours', async () => {
    const m = modelOf([]);
    await waitMs({ model: m, contact: '966501234567', method: 'whatsapp_otp', now: NOW });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].contact).toBe('966501234567');
    expect(m.calls[0].method).toBe('whatsapp_otp');
    expect(m.calls[0].createdAt.$gte.getTime()).toBe(NOW - DAY_MS);
  });

  test('no codes, or a few wrong guesses: verification stays open', async () => {
    expect(await waitMs({ model: modelOf([]), contact: 'c', method: 'm', now: NOW })).toBe(0);
    expect(await waitMs({ model: modelOf([row(2, 5 * MIN), row(1, 40 * MIN)]), contact: 'c', method: 'm', now: NOW })).toBe(0);
  });

  test('the attacker\'s pattern - three codes, five wrong guesses each, inside 10 minutes - is locked out for the rest of the hour', async () => {
    const rows = [row(5, 9 * MIN), row(5, 5 * MIN), row(5, 1 * MIN)]; // 15 in the hour
    const wait = await waitMs({ model: modelOf(rows), contact: 'c', method: 'm', now: NOW });
    expect(wait).toBeGreaterThan(0);
    // dropping the oldest (9 min ago) leaves 10, still at the limit; dropping the next (5 min ago) leaves 5: wait for that one to age out
    expect(wait).toBe(HOUR_MS - 5 * MIN);
  });

  test('the daily limit holds even when no single hour is over the hourly one', async () => {
    // 5 codes of 7 wrong guesses, 4 hours apart over the last day: never more than 7 in an hour, 35 in the day (limit 30)
    const rows = [row(7, 1 * HOUR_MS), row(7, 5 * HOUR_MS), row(7, 9 * HOUR_MS), row(7, 13 * HOUR_MS), row(7, 17 * HOUR_MS)];
    const wait = await waitMs({ model: modelOf(rows), contact: 'c', method: 'm', now: NOW });
    expect(wait).toBeGreaterThan(0);
    // dropping the oldest (17 h ago) leaves 28 < 30: that one leaves the 24-hour window in 7 hours
    expect(wait).toBe(7 * HOUR_MS);
  });

  test('the longer of the two waits is the one returned', async () => {
    const rows = [row(10, 1 * MIN), row(10, 10 * HOUR_MS), row(10, 20 * HOUR_MS)]; // hour: 10 (at limit); day: 30 (at limit)
    const wait = await waitMs({ model: modelOf(rows), contact: 'c', method: 'm', now: NOW });
    expect(wait).toBe(Math.max(HOUR_MS - 1 * MIN, 24 * HOUR_MS - 20 * HOUR_MS));
  });
});
