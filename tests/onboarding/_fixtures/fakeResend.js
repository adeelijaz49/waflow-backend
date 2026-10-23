'use strict';
// Fake e-mail port: send({ to, subject, html, text }) -> resolves { id } | rejects.
// Nothing leaves the process. `sent[]` keeps every accepted message for assertions.

const HTML_SPECIALS = /[<>&"']/;

/**
 * @param {{failFirst?: number, failWith?: Error|Function|object}} [opts]
 *   failFirst: the first N sends reject (then sends succeed) - use Infinity to always fail.
 *   failWith : an Error, a factory (input, attempt) => Error, or { message, code, statusCode }.
 */
function createFakeSend(opts = {}) {
  const initialFailFirst = opts.failFirst === undefined ? 0 : opts.failFirst;
  let failFirst = initialFailFirst;
  const failWith = opts.failWith;
  const sent = [];
  const failures = [];
  let attempts = 0;

  function makeError(input) {
    if (typeof failWith === 'function') return failWith(input, attempts);
    if (failWith instanceof Error) return failWith;
    const spec = failWith && typeof failWith === 'object' ? failWith : {};
    return Object.assign(new Error(spec.message || 'Fake e-mail provider failure'), {
      code: spec.code || 'FAKE_SEND_FAILURE',
      statusCode: spec.statusCode || 503,
    });
  }

  async function send(input) {
    attempts += 1;
    const msg = input || {};
    if (failFirst > 0) {
      failFirst -= 1;
      const err = makeError(msg);
      failures.push({ error: err, input: { to: msg.to, subject: msg.subject } });
      throw err;
    }
    const toList = Array.isArray(msg.to) ? msg.to : [msg.to];
    const badTo = toList.length === 0 || toList.some((t) => typeof t !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(t));
    if (badTo || typeof msg.subject !== 'string' || !msg.subject || (typeof msg.html !== 'string' && typeof msg.text !== 'string')) {
      const err = Object.assign(new Error('Fake e-mail provider: invalid message'), { code: 'FAKE_INVALID_MESSAGE', statusCode: 422 });
      failures.push({ error: err, input: { to: msg.to, subject: msg.subject } });
      throw err;
    }
    const id = 'email_fixture_' + (sent.length + 1);
    sent.push({
      id,
      to: Array.isArray(msg.to) ? msg.to.slice() : msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      from: msg.from,
      replyTo: msg.replyTo || msg.reply_to,
    });
    return { id };
  }

  return {
    send,
    sent,
    failures,
    get attempts() { return attempts; },
    reset() { sent.length = 0; failures.length = 0; attempts = 0; failFirst = initialFailFirst; },
    /** Throws when any secret appears in subject/html/text of any sent message. Secrets under 4 chars are refused. */
    assertNoLeak(secrets) {
      const bad = [];
      (secrets || []).forEach((s, k) => {
        if (typeof s !== 'string' || s.length < 4) throw new Error('assertNoLeak: secret #' + k + ' missing or too short to scan');
        sent.forEach((m, i) => {
          ['subject', 'html', 'text'].forEach((p) => {
            if (typeof m[p] === 'string' && m[p].includes(s)) bad.push('secret #' + k + ' (len ' + s.length + ') in sent[' + i + '].' + p);
          });
        });
      });
      if (bad.length) throw new Error('secret leaked into e-mail: ' + bad.join('; '));
      return true;
    },
    /**
     * For each user-controlled raw string that contains HTML specials, the raw form must NOT
     * appear in any html body (it must have been escaped). Throws otherwise.
     */
    assertEscaped(rawInputs) {
      const bad = [];
      (rawInputs || []).forEach((raw, k) => {
        if (typeof raw !== 'string' || !HTML_SPECIALS.test(raw)) return;
        sent.forEach((m, i) => {
          if (typeof m.html === 'string' && m.html.includes(raw)) bad.push('input #' + k + ' appears unescaped in sent[' + i + '].html');
        });
      });
      if (bad.length) throw new Error('unescaped user input in e-mail html: ' + bad.join('; '));
      return true;
    },
    /** Digit runs that look like phone numbers (8+ digits, optional + / spaces / dashes). Opt-in check. */
    findPhoneLike() {
      const found = [];
      sent.forEach((m, i) => {
        ['subject', 'html', 'text'].forEach((p) => {
          const s = m[p];
          if (typeof s !== 'string') return;
          const hits = s.match(/\+?\d[\d ()-]{6,}\d/g) || [];
          hits.forEach((h) => { if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(h) && h.replace(/\D/g, '').length >= 8) found.push({ i, part: p, hit: h }); });
        });
      });
      return found;
    },
  };
}

module.exports = { createFakeSend };
