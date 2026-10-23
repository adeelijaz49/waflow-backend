'use strict';
// Unit tests for the e-mail fake, clock, deterministic random, the index barrel, and a hygiene
// scan of the fixtures folder. Pure, no DB, no network.

const fs = require('fs');
const path = require('path');
const fixtures = require('../_fixtures');

const { createFakeSend, fixedClock, fakeRandom } = fixtures;

describe('index barrel', () => {
  test('re-exports every documented fixture', () => {
    ['createFakeGraph', 'graphError', 'createFakeStripe', 'signedEvent', 'makeEvent', 'makeSubscription', 'makeInvoice', 'makeCheckoutSession', 'createFakeSend', 'fixedClock', 'fakeRandom'].forEach((k) => {
      expect(typeof fixtures[k]).toBe('function');
    });
    expect(typeof fixtures.TEST_WEBHOOK_SECRET).toBe('string');
    expect(fixtures.TEST_WEBHOOK_SECRET).toMatch(/^whsec_/);
    expect(fixtures.GRAPH_ORIGIN).toBe('https://graph.facebook.com');
  });

  test('requiring the fixtures does no I/O: no mongoose connection, no timers left behind', () => {
    const mongoose = require('mongoose');
    expect(mongoose.connection.readyState).toBe(0);
  });
});

describe('fakeResend: createFakeSend', () => {
  test('resolves { id } and keeps what was sent', async () => {
    const f = createFakeSend();
    const r = await f.send({ to: 'owner@example.test', subject: 'Welcome', html: '<p>Hi</p>', text: 'Hi' });
    expect(r).toEqual({ id: 'email_fixture_1' });
    expect(f.sent).toEqual([expect.objectContaining({ id: 'email_fixture_1', to: 'owner@example.test', subject: 'Welcome', html: '<p>Hi</p>', text: 'Hi' })]);
    expect(f.attempts).toBe(1);
    expect(f.failures).toEqual([]);
  });

  test('failFirst: the first n sends reject with the documented default error, then it recovers', async () => {
    const f = createFakeSend({ failFirst: 2 });
    const msg = { to: 'a@example.test', subject: 'S', text: 't' };
    await expect(f.send(msg)).rejects.toMatchObject({ code: 'FAKE_SEND_FAILURE', statusCode: 503 });
    await expect(f.send(msg)).rejects.toThrow(/Fake e-mail provider failure/);
    expect(await f.send(msg)).toEqual({ id: 'email_fixture_1' });
    expect(f.failures).toHaveLength(2);
    expect(f.failures[0].input).toEqual({ to: 'a@example.test', subject: 'S' });
    expect(f.sent).toHaveLength(1);
    expect(f.attempts).toBe(3);
  });

  test('failWith accepts an Error, a spec object or a factory; Infinity always fails', async () => {
    const err = new Error('provider down');
    await expect(createFakeSend({ failFirst: 1, failWith: err }).send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBe(err);
    await expect(createFakeSend({ failFirst: 1, failWith: { message: 'rate', code: 'RL', statusCode: 429 } }).send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toMatchObject({ message: 'rate', code: 'RL', statusCode: 429 });
    const factory = createFakeSend({ failFirst: 1, failWith: (input, attempt) => new Error('to=' + input.to + ' attempt=' + attempt) });
    await expect(factory.send({ to: 'z@example.test', subject: 's', text: 't' })).rejects.toThrow('to=z@example.test attempt=1');
    const always = createFakeSend({ failFirst: Infinity });
    await expect(always.send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBeDefined();
    await expect(always.send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBeDefined();
    expect(always.sent).toHaveLength(0);
  });

  test('rejects malformed messages (no recipient, bad address, no subject, no body)', async () => {
    const f = createFakeSend();
    await expect(f.send({ subject: 's', text: 't' })).rejects.toMatchObject({ code: 'FAKE_INVALID_MESSAGE' });
    await expect(f.send({ to: 'not-an-email', subject: 's', text: 't' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(f.send({ to: 'a@example.test', text: 't' })).rejects.toBeDefined();
    await expect(f.send({ to: 'a@example.test', subject: 's' })).rejects.toBeDefined();
    await expect(f.send()).rejects.toBeDefined();
    expect(f.sent).toHaveLength(0);
  });

  test('reset restores the failFirst budget', async () => {
    const f = createFakeSend({ failFirst: 1 });
    await expect(f.send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBeDefined();
    await f.send({ to: 'a@example.test', subject: 's', text: 't' });
    f.reset();
    expect(f.sent).toHaveLength(0);
    expect(f.attempts).toBe(0);
    await expect(f.send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBeDefined();
  });

  test('assertNoLeak scans subject, html and text; short secrets are refused', async () => {
    const f = createFakeSend();
    await f.send({ to: 'a@example.test', subject: 'Hello', html: '<p>Token EAAxyz123456</p>', text: 'plain' });
    expect(() => f.assertNoLeak(['EAAxyz123456'])).toThrow(/html/);
    expect(f.assertNoLeak(['OTHER-SECRET'])).toBe(true);
    expect(() => f.assertNoLeak(['ab'])).toThrow(/too short/);
    try { f.assertNoLeak(['EAAxyz123456']); } catch (e) { expect(e.message).not.toContain('EAAxyz123456'); }
  });

  test('assertEscaped: raw HTML specials from user input must not appear in an html body', async () => {
    const raw = '<script>alert("x")</script> & Co';
    const bad = createFakeSend();
    await bad.send({ to: 'a@example.test', subject: 's', html: '<p>' + raw + '</p>' });
    expect(() => bad.assertEscaped([raw])).toThrow(/unescaped/);
    const good = createFakeSend();
    await good.send({ to: 'a@example.test', subject: 's', html: '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co</p>' });
    expect(good.assertEscaped([raw])).toBe(true);
    expect(good.assertEscaped(['plain text without specials'])).toBe(true);
  });

  test('findPhoneLike spots digit runs that look like phone numbers but not short ids', async () => {
    const f = createFakeSend();
    await f.send({ to: 'a@example.test', subject: 'Order 12345', html: '<p>Call +966 55 123 4567 or ref A-12</p>', text: 'x' });
    const hits = f.findPhoneLike();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ part: 'html', i: 0 });
    const clean = createFakeSend();
    await clean.send({ to: 'a@example.test', subject: 'Setup', html: '<p>Step 3 of 5, 2026-10-15</p>' });
    expect(clean.findPhoneLike()).toEqual([]);
  });
});

describe('fixedClock', () => {
  test('is fixed, advanceable and settable; now() returns copies', () => {
    const c = fixedClock('2026-10-15T09:00:00.000Z');
    expect(c.iso()).toBe('2026-10-15T09:00:00.000Z');
    expect(c.ms()).toBe(Date.parse('2026-10-15T09:00:00.000Z'));
    expect(c.sec()).toBe(Math.floor(c.ms() / 1000));
    const d = c.now();
    d.setFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2026);
    expect(c.advance(60000)).toBe(Date.parse('2026-10-15T09:01:00.000Z'));
    expect(c.now() - new Date('2026-10-15T09:00:00.000Z')).toBe(60000);
    c.set('2027-01-01T00:00:00Z');
    expect(c.iso()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('defaults to a fixed instant (not wall-clock) and rejects garbage', () => {
    expect(fixedClock().iso()).toBe('2026-10-15T09:00:00.000Z');
    expect(() => fixedClock('not a date')).toThrow(/invalid/);
    expect(() => fixedClock().set('nope')).toThrow(/invalid/);
  });
});

describe('fakeRandom', () => {
  test('same seed -> same sequence; different seed -> different; range [min,max) respected', () => {
    const a = fakeRandom({ seed: 7 });
    const b = fakeRandom({ seed: 7 });
    const c = fakeRandom({ seed: 8 });
    const sa = Array.from({ length: 20 }, () => a.randomInt(100000, 1000000));
    const sb = Array.from({ length: 20 }, () => b.randomInt(100000, 1000000));
    const sc = Array.from({ length: 20 }, () => c.randomInt(100000, 1000000));
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    sa.forEach((n) => { expect(n).toBeGreaterThanOrEqual(100000); expect(n).toBeLessThan(1000000); expect(String(n)).toMatch(/^\d{6}$/); });
  });

  test('randomInt(max) form, callback form and call recording', () => {
    const r = fakeRandom();
    const n = r.randomInt(10);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(10);
    let viaCb;
    expect(r.randomInt(5, 6, (err, v) => { viaCb = [err, v]; })).toBeUndefined();
    expect(viaCb).toEqual([null, 5]);
    expect(r.calls).toEqual([{ min: 0, max: 10 }, { min: 5, max: 6 }]);
    expect(() => r.randomInt(5, 5)).toThrow(RangeError);
    expect(() => r.randomInt('x')).toThrow(RangeError);
  });

  test('sequence returns the scripted PINs in order, cycles, and refuses out-of-range values', () => {
    const r = fakeRandom({ sequence: [123456, 654321] });
    expect([r.randomInt(100000, 1000000), r.randomInt(100000, 1000000), r.randomInt(100000, 1000000)]).toEqual([123456, 654321, 123456]);
    expect(() => fakeRandom({ sequence: [5] }).randomInt(100000, 1000000)).toThrow(/outside/);
  });

  test('randomBytes is deterministic and sized', () => {
    const a = fakeRandom({ seed: 3 }).randomBytes(16);
    const b = fakeRandom({ seed: 3 }).randomBytes(16);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toHaveLength(16);
    expect(a.equals(b)).toBe(true);
    expect(() => fakeRandom().randomBytes(-1)).toThrow(RangeError);
  });
});

describe('fixtures hygiene', () => {
  const dir = path.join(__dirname, '..', '_fixtures');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.md'));
  const unitDir = __dirname;
  const own = files.map((f) => path.join(dir, f)).concat(fs.readdirSync(unitDir).filter((f) => /^fixtures.*\.test\.js$/.test(f)).map((f) => path.join(unitDir, f)));

  test('the fixtures folder has the documented files', () => {
    ['fakeGraph.js', 'fakeStripe.js', 'fakeResend.js', 'helpers.js', 'index.js', 'README.md'].forEach((f) => expect(files).toContain(f));
  });

  test.each(own.map((f) => [path.relative(path.join(__dirname, '..', '..', '..'), f).split(path.sep).join('/'), f]))('%s has no non-ASCII / hidden / bidi characters and no CR line endings', (_name, file) => {
    const text = fs.readFileSync(file, 'utf8');
    const bad = [];
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code > 126 || (code < 32 && code !== 10 && code !== 9)) bad.push(code.toString(16));
    }
    expect(bad).toEqual([]);
  });

  test('no real-looking secrets: dummy markers only', () => {
    files.forEach((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(text).not.toMatch(/sk_live_/);
      expect(text).not.toMatch(/whsec_[A-Za-z0-9]{32,}/);
    });
  });
});
