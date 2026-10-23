'use strict';
// Tiny deterministic helpers shared by every onboarding test: a fixed clock and a seeded
// random source (for the register PIN). Pure, no I/O, nothing executed at require time.

const DEFAULT_START = '2026-10-15T09:00:00.000Z';

/**
 * A controllable clock. `now()` returns a fresh Date each call (so callers cannot mutate it);
 * `ms()` / `sec()` / `iso()` give the same instant as a number / seconds / ISO string.
 * @param {string|number|Date} [start]
 * @returns {{now: () => Date, ms: () => number, sec: () => number, iso: () => string,
 *   advance: (deltaMs: number) => number, set: (t: string|number|Date) => number}}
 */
function fixedClock(start = DEFAULT_START) {
  let t = new Date(start).getTime();
  if (!Number.isFinite(t)) throw new Error('fixedClock: invalid start');
  const clock = {
    now: () => new Date(t),
    ms: () => t,
    sec: () => Math.floor(t / 1000),
    iso: () => new Date(t).toISOString(),
    advance(deltaMs) { t += Number(deltaMs) || 0; return t; },
    set(v) {
      const n = new Date(v).getTime();
      if (!Number.isFinite(n)) throw new Error('fixedClock.set: invalid time');
      t = n;
      return t;
    },
  };
  return clock;
}

// mulberry32: small, fast, fully deterministic 32-bit PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic stand-in for `crypto.randomInt` / `crypto.randomBytes`.
 *  - `randomInt(max)` or `randomInt(min, max)` (max exclusive), like Node. An optional trailing
 *    callback is supported too.
 *  - `sequence: [123456, 654321]` makes randomInt return those values in order (cycling); each
 *    must fall inside the requested range, otherwise the fake throws (a bad test setup).
 *  - `randomBytes(n)` returns a deterministic Buffer.
 * `calls` records every request, so a test can assert the PIN range ([100000, 1000000)).
 * @param {{seed?: number, sequence?: number[]}} [opts]
 */
function fakeRandom(opts = {}) {
  const rand = mulberry32(opts.seed === undefined ? 1 : opts.seed);
  const sequence = Array.isArray(opts.sequence) ? opts.sequence.slice() : null;
  let seqIndex = 0;
  const calls = [];

  function randomInt(...args) {
    let cb = null;
    if (typeof args[args.length - 1] === 'function') cb = args.pop();
    const min = args.length >= 2 ? args[0] : 0;
    const max = args.length >= 2 ? args[1] : args[0];
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min) {
      throw new RangeError('fakeRandom.randomInt: bad range');
    }
    calls.push({ min, max });
    let value;
    if (sequence && sequence.length) {
      value = sequence[seqIndex % sequence.length];
      seqIndex += 1;
      if (!Number.isSafeInteger(value) || value < min || value >= max) {
        throw new RangeError('fakeRandom: sequence value ' + value + ' outside [' + min + ', ' + max + ')');
      }
    } else {
      value = min + Math.floor(rand() * (max - min));
    }
    if (cb) { cb(null, value); return undefined; }
    return value;
  }

  function randomBytes(n) {
    const size = Number(n);
    if (!Number.isInteger(size) || size < 0) throw new RangeError('fakeRandom.randomBytes: bad size');
    calls.push({ bytes: size });
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) buf[i] = Math.floor(rand() * 256);
    return buf;
  }

  return { randomInt, randomBytes, calls };
}

module.exports = { fixedClock, fakeRandom, mulberry32 };
