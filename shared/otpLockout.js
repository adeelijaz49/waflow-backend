'use strict';
// Guessing a WhatsApp login code. One code allows 5 wrong guesses, but a new code can be requested 3 times every 10 minutes, so on
// its own that is 15 guesses per 10 minutes at one number, for as long as someone cares to keep going. This adds the limit that
// counts the wrong guesses across ALL the codes of a number: MAX_PER_HOUR in any hour and MAX_PER_DAY in any day, after which
// verification is refused until enough of them have aged out. It reads the same LoginChallenge rows the per-code limit uses (their
// `attempts` counters), so it needs no new collection and holds across server instances.
// The email link is not affected: its token is 256 bits, nothing to guess.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_PER_HOUR = 10;
const MAX_PER_DAY = 30;

const at = (row) => new Date(row.createdAt).getTime();

// Milliseconds until the wrong guesses made inside `windowMs` drop below `max` again (0 = not over the limit). A guess is dated
// by the code it was made against, which is never later than the guess itself, so the wait is never longer than it should be.
function waitForWindow(rows, windowMs, max, now) {
  const inWindow = rows.filter((r) => now - at(r) < windowMs).sort((a, b) => at(a) - at(b));
  let total = inWindow.reduce((n, r) => n + (Number(r.attempts) || 0), 0);
  if (total < max) return 0;
  for (const r of inWindow) {
    total -= Number(r.attempts) || 0;
    if (total < max) return Math.max(0, at(r) + windowMs - now);
  }
  return windowMs;
}

/**
 * @param {{ model: { find: Function }, contact: string, method: string, now?: number }} args  model = LoginChallenge
 * @returns {Promise<number>} milliseconds to wait before another guess is accepted; 0 when verification is open
 */
async function waitMs({ model, contact, method, now = Date.now() }) {
  const rows = await model.find({ contact, method, createdAt: { $gte: new Date(now - DAY_MS) } }).select('attempts createdAt').lean();
  return Math.max(waitForWindow(rows, HOUR_MS, MAX_PER_HOUR, now), waitForWindow(rows, DAY_MS, MAX_PER_DAY, now));
}

module.exports = { waitMs, waitForWindow, MAX_PER_HOUR, MAX_PER_DAY, HOUR_MS, DAY_MS };
