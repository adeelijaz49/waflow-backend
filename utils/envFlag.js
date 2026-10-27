'use strict';
// How an on/off setting is read from the environment, in one place.
//   ON  : on, true, 1, yes          OFF : off, false, 0, no          (any capitals, spaces around are ignored)
//   unset or empty : the caller's default.
//   anything else  : "not understood" - the caller's default applies AND it is reported once (warnUnknown, called at start-up), because a
//   typo in a switch that is meant to be a safety net (TEMPLATE_APPROVAL_SWEEP=flase, CONSENT_REQUIRE_SIGNATURE=ture) must not pass silently.
const ON = new Set(['on', 'true', '1', 'yes']);
const OFF = new Set(['off', 'false', '0', 'no']);

/** @returns {'on'|'off'|'unset'|'unknown'} */
function read(name, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === null) return 'unset';
  const v = String(raw).trim().toLowerCase();
  if (!v) return 'unset';
  if (ON.has(v)) return 'on';
  if (OFF.has(v)) return 'off';
  return 'unknown';
}

/**
 * The setting as a boolean. `defaultValue` when it is unset. A value that is not understood is `defaultValue` too, unless `unknown`
 * (true / false) says what it counts as: a switch whose typo would leave something open reads an unknown value as the safe side.
 */
function isOn(name, defaultValue = false, env = process.env, unknown) {
  const v = read(name, env);
  if (v === 'on') return true;
  if (v === 'off') return false;
  if (v === 'unknown' && typeof unknown === 'boolean') return unknown;
  return defaultValue;
}

const reported = new Set();
/**
 * Log (once per name and value) every listed setting whose value is not understood. Never throws.
 * @param {Array<string | { name: string, treatedAs: 'on' | 'off' }>} names  treatedAs: what an unknown value counts as, when it is not the default
 */
function warnUnknown(names, env = process.env, log = console.warn) {
  for (const item of names) {
    try {
      const name = typeof item === 'string' ? item : item.name;
      if (read(name, env) !== 'unknown') continue;
      const key = `${name}=${env[name]}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const outcome = typeof item === 'object' && item.treatedAs ? `it is treated as ${item.treatedAs}` : 'the default is used';
      log(`[env] ${name}="${String(env[name]).slice(0, 40)}" is not understood (use on or off): ${outcome}.`);
    } catch (_) { /* a log line is never worth a crash */ }
  }
}

module.exports = { read, isOn, warnUnknown, ON, OFF };
