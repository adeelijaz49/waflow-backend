'use strict';
// Unit tests for utils/envFlag.js: how an on/off setting is read, and that a value nobody understands is reported (not obeyed silently).
const envFlag = require('../utils/envFlag');

const env = (v) => (v === undefined ? {} : { FLAG: v });

describe('read', () => {
  test.each(['on', 'ON', ' On ', 'true', 'TRUE', '1', 'yes', 'Yes'])('%j is on', (v) => expect(envFlag.read('FLAG', env(v))).toBe('on'));
  test.each(['off', 'OFF', ' off ', 'false', 'False', '0', 'no', 'NO'])('%j is off', (v) => expect(envFlag.read('FLAG', env(v))).toBe('off'));
  test.each([undefined, '', '   '])('%j is unset', (v) => expect(envFlag.read('FLAG', env(v))).toBe('unset'));
  test.each(['flase', 'ture', 'enabled', '2', 'o n', 'onn'])('%j is not understood', (v) => expect(envFlag.read('FLAG', env(v))).toBe('unknown'));
  test('null counts as unset', () => expect(envFlag.read('FLAG', { FLAG: null })).toBe('unset'));
});

describe('isOn', () => {
  test('on / off decide; unset and not-understood take the default', () => {
    expect(envFlag.isOn('FLAG', false, env('yes'))).toBe(true);
    expect(envFlag.isOn('FLAG', true, env('no'))).toBe(false);
    for (const dflt of [true, false]) {
      expect(envFlag.isOn('FLAG', dflt, env(undefined))).toBe(dflt);
      expect(envFlag.isOn('FLAG', dflt, env(''))).toBe(dflt);
      expect(envFlag.isOn('FLAG', dflt, env('flase'))).toBe(dflt);
    }
  });
  test('the default of the default is off, and process.env is what is read when no env is passed', () => {
    expect(envFlag.isOn('FLAG', undefined, env(undefined))).toBe(false);
    process.env.ENVFLAG_TEST_SWITCH = 'on';
    try { expect(envFlag.isOn('ENVFLAG_TEST_SWITCH')).toBe(true); } finally { delete process.env.ENVFLAG_TEST_SWITCH; }
  });
  // the settings this app reads through it keep their old meaning
  test('the old spellings still mean what they meant', () => {
    // a switch that is on by default (TEMPLATE_APPROVAL_SWEEP): off / false / 0 / no turn it off, an empty value keeps it on
    for (const v of ['false', 'FALSE', ' false ', '0', 'off', 'no']) expect(envFlag.isOn('FLAG', true, env(v))).toBe(false);
    for (const v of ['true', '1', 'yes', 'on', '']) expect(envFlag.isOn('FLAG', true, env(v))).toBe(true);
    // CONSENT_REQUIRE_SIGNATURE / PROMO_ENTRY_FALLBACK / WEBHOOK_LOG_BODIES (default off): on / true / 1 / yes are on, the rest is off
    for (const v of ['on', 'true', '1', 'yes', 'ON']) expect(envFlag.isOn('FLAG', false, env(v))).toBe(true);
    for (const v of ['off', 'false', '', 'anything']) expect(envFlag.isOn('FLAG', false, env(v))).toBe(false);
  });
  test('"unknown": a value that is not understood can be made to count as on or off (a switch whose typo would leave something open); it never overrides a value that is understood', () => {
    for (const v of ['flase', 'disabled', 'anything']) {
      expect(envFlag.isOn('FLAG', true, env(v), false)).toBe(false);
      expect(envFlag.isOn('FLAG', false, env(v), true)).toBe(true);
      expect(envFlag.isOn('FLAG', true, env(v))).toBe(true); // no `unknown` given: the default
    }
    expect(envFlag.isOn('FLAG', true, env('on'), false)).toBe(true);
    expect(envFlag.isOn('FLAG', true, env('off'), true)).toBe(false);
    expect(envFlag.isOn('FLAG', true, env(undefined), false)).toBe(true); // unset is not "not understood": the default
    expect(envFlag.isOn('FLAG', true, env(''), false)).toBe(true);
  });
});

describe('warnUnknown', () => {
  test('says so once for a value that is not understood, names the setting, and is silent for the rest', () => {
    const lines = [];
    const log = (l) => lines.push(l);
    const e = { A_ON: 'on', B_OFF: 'off', C_UNSET: undefined, D_EMPTY: '', E_TYPO: 'flase', F_TYPO: 'ture' };
    envFlag.warnUnknown(['A_ON', 'B_OFF', 'C_UNSET', 'D_EMPTY', 'E_TYPO', 'F_TYPO', 'G_MISSING'], e, log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/E_TYPO="flase" is not understood/);
    expect(lines[1]).toMatch(/F_TYPO="ture" is not understood/);
    envFlag.warnUnknown(['E_TYPO', 'F_TYPO'], e, log); // the same values are not said again
    expect(lines).toHaveLength(2);
    envFlag.warnUnknown(['E_TYPO'], { E_TYPO: 'fasle' }, log); // a different value is
    expect(lines).toHaveLength(3);
  });
  test('says what an unknown value counts as when the setting is not simply given its default', () => {
    const lines = [];
    envFlag.warnUnknown([{ name: 'SIGNUP_SWITCH', treatedAs: 'off' }, 'OTHER_SWITCH'], { SIGNUP_SWITCH: 'closed?', OTHER_SWITCH: 'maybe' }, (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/SIGNUP_SWITCH="closed\?" is not understood \(use on or off\): it is treated as off\./);
    expect(lines[1]).toMatch(/OTHER_SWITCH="maybe" is not understood \(use on or off\): the default is used\./);
  });
  test('a long value is cut and a failing log never throws', () => {
    const lines = [];
    envFlag.warnUnknown(['LONG_ONE'], { LONG_ONE: 'x'.repeat(500) }, (l) => lines.push(l));
    expect(lines[0].length).toBeLessThan(160);
    expect(() => envFlag.warnUnknown(['BOOM'], { BOOM: 'nope' }, () => { throw new Error('log failed'); })).not.toThrow();
  });
});
