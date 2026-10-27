'use strict';
// Unit tests for shared/webhookBudget.js: how much work one inbound webhook request may make the server do. Pure: no database.
const {
  MAX_UNSIGNED_EVENTS, MAX_UNSIGNED_STATUSES, TEMPLATE_EVENT_COST, newBudget, takeEvents, takeStatuses,
} = require('../shared/webhookBudget');

const list = (n) => Array.from({ length: n }, (_, i) => ({ i }));

describe('a request Meta signed', () => {
  test('is never limited: every message, delivery update and template change is let through, nothing is counted as skipped', () => {
    const budget = newBudget('valid');
    expect(takeEvents(budget, list(5000))).toHaveLength(5000);
    expect(takeStatuses(budget, list(5000))).toHaveLength(5000);
    expect(takeEvents(budget, list(100), TEMPLATE_EVENT_COST)).toHaveLength(100);
    expect(budget.skipped).toBe(0);
  });
});

describe('a request that is not positively signed (wrong, missing, or no secret to check with)', () => {
  test.each(['invalid', 'missing', 'unconfigured', undefined, ''])('%j gets the capped allowance', (signature) => {
    const budget = newBudget(signature);
    expect(budget.left).toBe(MAX_UNSIGNED_EVENTS);
    expect(budget.statusesLeft).toBe(MAX_UNSIGNED_STATUSES);
    expect(budget.skipped).toBe(0);
  });

  test('the limits are the documented ones: 25 messages / template changes, 500 delivery updates, 5 events per template change', () => {
    expect([MAX_UNSIGNED_EVENTS, MAX_UNSIGNED_STATUSES, TEMPLATE_EVENT_COST]).toEqual([25, 500, 5]);
  });

  test('messages: the first 25 are taken, the rest is counted as skipped, across several lists of the same request', () => {
    const budget = newBudget('invalid');
    expect(takeEvents(budget, list(10))).toHaveLength(10);
    expect(takeEvents(budget, list(10))).toHaveLength(10);
    expect(takeEvents(budget, list(10))).toHaveLength(5); // 25 in all
    expect(budget.skipped).toBe(5);
    expect(takeEvents(budget, list(3))).toEqual([]);
    expect(budget.skipped).toBe(8);
    expect(budget.left).toBe(0);
  });

  test('the items taken are the FIRST ones, in order', () => {
    const budget = newBudget('missing');
    expect(takeEvents(budget, list(30)).map((x) => x.i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test('delivery updates have their own allowance: they neither use up the messages\' nor are used up by them', () => {
    const budget = newBudget('unconfigured');
    expect(takeEvents(budget, list(25))).toHaveLength(25); // the message allowance is gone ...
    expect(takeStatuses(budget, list(300))).toHaveLength(300); // ... delivery updates are not affected (a promotion to a few hundred customers batches that many)
    expect(takeStatuses(budget, list(300))).toHaveLength(200); // 500 in all
    expect(budget.skipped).toBe(100);
    const fresh = newBudget('unconfigured');
    expect(takeStatuses(fresh, list(500))).toHaveLength(500);
    expect(takeEvents(fresh, list(25))).toHaveLength(25);
    expect(fresh.skipped).toBe(0);
  });

  test('a template change costs five events: at most five of them per request, and they share the allowance with messages', () => {
    const budget = newBudget('invalid');
    expect(takeEvents(budget, list(8), TEMPLATE_EVENT_COST)).toHaveLength(5);
    expect(budget.skipped).toBe(3);
    expect(budget.left).toBe(0);
    expect(takeEvents(budget, list(1))).toEqual([]); // nothing left for messages either

    const mixed = newBudget('invalid');
    expect(takeEvents(mixed, list(21))).toHaveLength(21); // 4 left
    expect(takeEvents(mixed, [{ change: 1 }], TEMPLATE_EVENT_COST)).toEqual([]); // not enough for one template change (costs 5) ...
    expect(mixed.left).toBe(4); // ... and nothing is charged for it
    expect(takeEvents(mixed, list(4))).toHaveLength(4); // the messages still fit
    expect(mixed.skipped).toBe(1);
  });

  test('anything that is not a list is no events', () => {
    const budget = newBudget('invalid');
    for (const bad of [undefined, null, 'x', 7, {}]) expect(takeEvents(budget, bad)).toEqual([]);
    expect(takeStatuses(budget, undefined)).toEqual([]);
    expect(budget.skipped).toBe(0);
    expect(budget.left).toBe(MAX_UNSIGNED_EVENTS);
  });
});
