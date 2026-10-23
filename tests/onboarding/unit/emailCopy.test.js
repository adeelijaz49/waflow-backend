'use strict';
const emailCopy = require('../../../shared/onboarding/emailCopy');
const { KINDS } = require('../../../shared/onboarding/notifications');

const LANGS = ['en', 'ar'];
const HOSTILE = {
  templateKey: '<img src=x onerror=alert(1)>',
  reason: '"><script>alert(1)</script>',
  tier: "'; DROP TABLE x; --",
  decision: '<b>bold</b> & more',
  status: '&lt;already&gt;',
  actionPath: '/setup"><script>alert(2)</script>',
};
const RAW_PIECES = ['<img', '<script', '</script>', '<b>'];
let savedUrl;
beforeEach(() => { savedUrl = process.env.FRONTEND_URL; process.env.FRONTEND_URL = 'https://app.example.test/'; });
afterEach(() => { if (savedUrl === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = savedUrl; });

describe('esc', () => {
  test('escapes the five HTML specials and tolerates null/undefined/numbers', () => {
    expect(emailCopy.esc('<a href="x" onclick=\'y\'>&</a>')).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(emailCopy.esc(null)).toBe('');
    expect(emailCopy.esc(undefined)).toBe('');
    expect(emailCopy.esc(42)).toBe('42');
  });
});

describe('coverage', () => {
  test('there is real copy for EVERY notifications.KINDS entry in English and Arabic', () => {
    expect(emailCopy.KINDS.slice().sort()).toEqual(KINDS.slice().sort());
    const generic = { en: emailCopy.render('no_such_kind', 'en', {}), ar: emailCopy.render('no_such_kind', 'ar', {}) };
    for (const kind of KINDS) {
      for (const lang of LANGS) {
        const m = emailCopy.render(kind, lang, {});
        expect(typeof m.subject).toBe('string');
        expect(m.subject.length).toBeGreaterThan(3);
        expect(m.html).toContain('<html');
        expect(m.text.length).toBeGreaterThan(20);
        expect(m.subject).not.toBe(generic[lang].subject); // not the fallback
      }
    }
  });
  test('Arabic copy is a draft and differs from English', () => {
    expect(emailCopy.ARABIC_STATUS).toBe('draft');
    for (const kind of KINDS) {
      const en = emailCopy.render(kind, 'en', {});
      const ar = emailCopy.render(kind, 'ar', {});
      expect(ar.subject).not.toBe(en.subject);
      expect(/[\u{600}-\u{6ff}]/u.test(ar.subject)).toBe(true);
    }
  });
  test('unknown kind and unknown language fall back instead of throwing', () => {
    expect(emailCopy.render('nope', 'en', {}).subject).toBe('Update on your setup');
    expect(emailCopy.render('__proto__', 'en', {}).subject).toBe('Update on your setup');
    expect(emailCopy.render('connected', 'fr', {}).html).toContain('lang="en"');
    expect(emailCopy.render('connected', undefined, undefined).subject).toBe('WhatsApp is connected to WaFlow');
  });
});

describe('escaping with hostile inputs (every kind, en + ar)', () => {
  test.each(KINDS.flatMap((k) => LANGS.map((l) => [k, l])))('%s / %s', (kind, lang) => {
    const m = emailCopy.render(kind, lang, HOSTILE);
    for (const piece of RAW_PIECES) expect(m.html).not.toContain(piece);
    // the dynamic values appear, escaped
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m.html).toContain('&#39;; DROP TABLE x; --');
    expect(m.html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more');
    expect(m.html).toContain('&amp;lt;already&amp;gt;');
    // a hostile actionPath is refused: the link falls back to the default path
    expect(m.html).toContain('href="https://app.example.test/setup"');
    expect(m.html.match(/<script/gi)).toBeNull();
    expect(m.html.match(/<[a-z][^>]*\son[a-z]+=/gi)).toBeNull(); // no tag carries an event handler
  });
  test('the subject is static: hostile params never reach it', () => {
    for (const kind of KINDS) for (const lang of LANGS) {
      expect(emailCopy.render(kind, lang, HOSTILE).subject).toBe(emailCopy.render(kind, lang, {}).subject);
      expect(emailCopy.render(kind, lang, HOSTILE).subject).not.toMatch(/[<>&"]/);
    }
  });
});

describe('no phone numbers, tokens, e-mail addresses or workspace names', () => {
  const SENSITIVE = {
    templateKey: '966501234567',
    reason: 'call +966 50 123 4567 now',
    tier: 'owner@example.test',
    decision: 'EAAFXTdummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    status: 'APPROVED',
    workspaceName: "Adeel's Workspace",
    phone: '966501234567',
    token: 'EAAFXTdummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    email: 'someone@example.test',
  };
  test.each(KINDS.flatMap((k) => LANGS.map((l) => [k, l])))('%s / %s drops sensitive-looking values and ignores unknown keys', (kind, lang) => {
    const m = emailCopy.render(kind, lang, SENSITIVE);
    const all = `${m.subject}\n${m.html}\n${m.text}`;
    expect(all).not.toMatch(/966/);
    expect(all).not.toMatch(/EAAG/);
    expect(all).not.toMatch(/@example\.test/);
    expect(all).not.toContain('Adeel');
    expect(all).not.toMatch(/\d{7,}/);
    expect(m.html).toContain('APPROVED'); // harmless values still shown
  });
  test('control characters and bidi marks inside a value are stripped', () => {
    const m = emailCopy.render('template_rejected', 'en', { reason: `A${String.fromCharCode(0)}B${String.fromCharCode(0x202e)}C\nD` });
    expect(m.html).toContain('A B C D');
    expect(m.html).not.toMatch(/[\u{0}-\u{8}\u{202e}]/u);
  });
});

describe('payment wording and layout', () => {
  test('only payment_failed mentions fees, and only with the neutral line; no price/currency/plan anywhere', () => {
    const neutralEn = 'WhatsApp message fees are charged by Meta to your own Meta account.';
    for (const kind of KINDS) {
      const en = emailCopy.render(kind, 'en', {});
      const ar = emailCopy.render(kind, 'ar', {});
      if (kind === 'payment_failed') {
        expect(en.text).toContain(neutralEn);
        expect(en.html).toContain(neutralEn);
        expect(ar.text).toContain(emailCopy.FEES_AR);
      } else {
        expect(en.text).not.toMatch(/fees?\b/i);
        expect(ar.text).not.toContain(emailCopy.FEES_AR);
      }
      for (const m of [en, ar]) {
        expect(`${m.subject}${m.html}`).not.toMatch(/\$|SAR|USD|AED|ر\.س|credit|plan name|per month|\d+\s?%/i);
      }
    }
  });
  test('Arabic mails are right-to-left, use the glossary word for WhatsApp and no physical left/right CSS', () => {
    for (const kind of KINDS) {
      const ar = emailCopy.render(kind, 'ar', { reason: 'X' });
      expect(ar.html).toContain('<html lang="ar" dir="rtl">');
      expect(ar.html).toContain('<body dir="rtl"');
      expect(ar.text).not.toMatch(/WhatsApp/);
      for (const lang of LANGS) {
        const html = emailCopy.render(kind, lang, {}).html;
        expect(html).not.toMatch(/(margin|padding|border)-(left|right)|text-align:\s*(left|right)|float:|(^|[;"\s])(left|right):/);
      }
    }
    expect(emailCopy.render('connected', 'en', {}).html).toContain('<html lang="en" dir="ltr">');
  });
  test('links come from config.frontendUrl() and the notification actionPath', () => {
    const def = emailCopy.render('connected', 'en', {});
    expect(def.html).toContain('href="https://app.example.test/setup"');
    expect(def.text).toContain('Continue setup: https://app.example.test/setup');
    const custom = emailCopy.render('connected', 'en', { actionPath: '/setup/approvals' });
    expect(custom.html).toContain('href="https://app.example.test/setup/approvals"');
    delete process.env.FRONTEND_URL;
    expect(emailCopy.render('connected', 'en', {}).html).toContain('href="http://localhost:4200/setup"');
    process.env.FRONTEND_URL = 'https://x.test/path///';
    expect(emailCopy.render('connected', 'en', {}).html).toContain('href="https://x.test/path/setup"');
  });
  test('Path B reminder copy: "Come back when your number is ready", delivered by e-mail and in the app, never WhatsApp', () => {
    const m = emailCopy.render('pathb_reminder', 'en', { n: 2 });
    expect(m.subject).toBe('Come back when your number is ready');
    expect(m.text).toContain('never on WhatsApp');
    expect(emailCopy.render('pathb_reminder', 'ar', {}).subject).toBe('عد عندما يصبح رقمك جاهزاً');
  });
});

describe('template_approved: the generic mail and the two coalesced MILESTONE mails', () => {
  const FIRST = { en: 'Your first message template was approved', ar: 'تم اعتماد أول قالب رسالة لديك' };
  const ALL = { en: 'Your starter message templates are approved', ar: 'تم اعتماد قوالب الرسائل الأولية لديك' };
  const GENERIC = { en: 'A message template was approved', ar: 'تم اعتماد قالب رسالة' };
  const PROGRESS = { en: (c, t) => `Approved: ${c} of ${t}`, ar: (c, t) => `المعتمد: ${c} من ${t}` };

  test.each(LANGS)('%s: count < total = first approved, count >= total = all approved, no counts = the generic text (three different subjects)', (lang) => {
    expect(emailCopy.render('template_approved', lang, { count: 1, total: 7 }).subject).toBe(FIRST[lang]);
    expect(emailCopy.render('template_approved', lang, { count: 7, total: 7 }).subject).toBe(ALL[lang]);
    expect(emailCopy.render('template_approved', lang, { count: 1, total: 1 }).subject).toBe(ALL[lang]);
    expect(emailCopy.render('template_approved', lang, {}).subject).toBe(GENERIC[lang]);
    expect(emailCopy.render('template_approved', lang, { template: 'Weekend offer', language: 'en' }).subject).toBe(GENERIC[lang]);
    expect(new Set([FIRST[lang], ALL[lang], GENERIC[lang]]).size).toBe(3);
  });
  test.each(LANGS)('%s: the milestone mails show the counts only (a progress line) - no template name, no key, no phone number', (lang) => {
    const first = emailCopy.render('template_approved', lang, { count: 1, total: 7, template: 'Weekend offer' }); // `template` (a per-template name) is never a detail
    expect(first.text).toContain(PROGRESS[lang](1, 7));
    expect(first.html).toContain(`<strong>${PROGRESS[lang](1, 7).replace(': ', ':</strong> ')}`);
    expect(first.text).not.toContain('Weekend');
    expect(first.text).toContain(lang === 'ar' ? 'عرض القوالب' : 'View templates');
    const all = emailCopy.render('template_approved', lang, { count: 7, total: 7 });
    expect(all.text).toContain(PROGRESS[lang](7, 7));
    expect(`${all.subject}${all.html}${all.text}`).not.toMatch(/\d{7,}|@|966|wf_/);
  });
  test('the generic mail has no progress line, and a notification of another kind with count/total never gets one', () => {
    expect(emailCopy.render('template_approved', 'en', {}).text).not.toMatch(/Approved: /);
    expect(emailCopy.render('connected', 'en', { count: 1, total: 7 }).text).not.toMatch(/Approved: /);
    expect(emailCopy.render('connected', 'en', { count: 1, total: 7 }).subject).toBe('WhatsApp is connected to WaFlow');
  });
  test('non-numeric, hostile or impossible counts never select a variant and are never printed', () => {
    const hostile = [{ count: '1', total: '7' }, { count: '<b>1</b>', total: 7 }, { count: NaN, total: 7 }, { count: 0, total: 7 }, { count: 1, total: 0 }, { count: -3, total: 5 }, { count: Infinity, total: Infinity }, { count: null, total: 7 }];
    for (const params of hostile) {
      const m = emailCopy.render('template_approved', 'en', params);
      expect([JSON.stringify(params), m.subject]).toEqual([JSON.stringify(params), GENERIC.en]);
      expect(m.html).not.toContain('<b>1');
      expect(m.text).not.toMatch(/Approved: /);
    }
    const big = emailCopy.render('template_approved', 'en', { count: 5000, total: 100000 });
    expect(big.text).toContain('Approved: 999 of 999'); // printed counts are capped
  });
  test('the milestone mails respect every house rule: static subject, escaped, Arabic right-to-left without Latin WhatsApp, no fee / price / plan words', () => {
    for (const lang of LANGS) for (const params of [{ count: 1, total: 7 }, { count: 7, total: 7 }]) {
      const m = emailCopy.render('template_approved', lang, { ...params, ...HOSTILE });
      expect(m.subject).not.toMatch(/[<>&"]/);
      expect(m.html.match(/<script/gi)).toBeNull();
      expect(`${m.subject}${m.html}`).not.toMatch(/\$|SAR|USD|AED|ر\.س|credit|plan name|per month|\d+\s?%/i);
      expect(m.text).not.toMatch(/fees?\b/i);
      if (lang === 'ar') {
        expect(m.html).toContain('<html lang="ar" dir="rtl">');
        expect(m.text).not.toMatch(/WhatsApp/);
        expect(/[\u{600}-\u{6ff}]/u.test(m.subject)).toBe(true);
      }
    }
  });
});

describe('Step 4 status words (verification_changed / display_name_decided carry params.status)', () => {
  test.each([['done', 'Done', 'تم'], ['waiting', 'Waiting on Meta', 'بانتظار Meta'], ['needs_you', 'Needs you', 'يحتاج إلى إجراء منك']])('%s -> the checklist words, not the raw token', (status, en, ar) => {
    for (const kind of ['verification_changed', 'display_name_decided']) {
      const e = emailCopy.render(kind, 'en', { status });
      expect(e.text).toContain(`Status: ${en}`);
      expect(e.text).not.toContain(status === 'needs_you' ? 'needs_you' : `Status: ${status}`);
      expect(emailCopy.render(kind, 'ar', { status }).text).toContain(`الحالة: ${ar}`);
    }
  });
  test('"unknown" shows no status line; any other value is shown as before (cleaned and escaped)', () => {
    expect(emailCopy.render('verification_changed', 'en', { status: 'unknown' }).text).not.toMatch(/Status:/);
    expect(emailCopy.render('verification_changed', 'en', { status: 'APPROVED' }).text).toContain('Status: APPROVED');
    expect(emailCopy.render('verification_changed', 'en', { status: 'done' }).html).toContain('<strong>Status:</strong> Done');
    expect(emailCopy.render('verification_changed', 'en', { status: '__proto__' }).text).toContain('Status: __proto__');
    expect(emailCopy.render('verification_changed', 'en', { status: 'constructor' }).text).toContain('Status: constructor');
  });
});

describe('renderSupport', () => {
  const req = {
    kind: 'help', businessName: '<b>Acme</b> & "Sons"', step: 'connect', lastErrorCode: 'CONNECT_PARTIAL',
    contactEmail: 'owner@example.test', message: `Line one\r\n<script>alert(1)</script>\nLine ${String.fromCharCode(0)}three${String.fromCharCode(0x202e)}`,
  };
  test('static subject, every dynamic value escaped, newlines kept as <br>', () => {
    const m = emailCopy.renderSupport(req);
    expect(m.subject).toBe('WaFlow onboarding help request');
    expect(m.html).not.toContain('<script');
    expect(m.html).not.toContain('<b>Acme');
    expect(m.html).toContain('&lt;b&gt;Acme&lt;/b&gt; &amp; &quot;Sons&quot;');
    expect(m.html).toContain('Line one<br>&lt;script&gt;alert(1)&lt;/script&gt;<br>Line three');
    expect(m.html).toContain('CONNECT_PARTIAL');
    expect(m.text).toContain('Business name: <b>Acme</b> & "Sons"');
  });
  test('message is capped at 500 characters and an empty request still renders', () => {
    const m = emailCopy.renderSupport({ message: 'Z'.repeat(900) });
    expect((m.html.match(/Z/g) || []).length).toBe(500);
    expect(emailCopy.renderSupport().html).toContain('<h2>');
    expect(emailCopy.renderSupport(null).text).toContain('Message:');
  });
});
