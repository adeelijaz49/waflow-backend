'use strict';
// What a person typed (a customer's name, a support message) must reach the HTML of an e-mail as text, never as markup, and
// must not be able to break the subject line. Resend is mocked: nothing is sent.
const sent = [];
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn(async (payload) => { sent.push(payload); return { data: { id: 'email_1' }, error: null }; }) },
  })),
}));

const { sendInviteEmail, sendSupportTicketEmail, sendMagicLinkEmail, escapeHtml } = require('../utils/email');

const EVIL = '<img src=x onerror=alert(1)><a href="https://evil.example">click</a>&"\'';

beforeEach(() => { sent.length = 0; });

describe('escapeHtml', () => {
  test('the five characters that open markup become entities; everything else is untouched', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(escapeHtml('plain text 123 — العربية')).toBe('plain text 123 — العربية');
  });
  test('null, undefined and numbers are text too', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('invite e-mail', () => {
  test('a customer name containing markup is shown as text in the body', async () => {
    await sendInviteEmail('new@example.com', EVIL, 'https://app.example/login');
    const html = sent[0].html;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<strong>');
    expect(html).toContain('href="https://app.example/login"'); // the real link is still a link
  });

  test('a line break in the name cannot split the subject', async () => {
    await sendInviteEmail('new@example.com', 'Evil\r\nBcc: someone@example.com', 'https://app.example/login');
    expect(sent[0].subject).not.toMatch(/[\r\n]/);
    expect(sent[0].subject).toContain('Evil Bcc: someone@example.com'); // one flat line of text
  });
});

describe('support ticket e-mail', () => {
  test('every field a person typed is escaped, and the message keeps its line breaks', async () => {
    await sendSupportTicketEmail({ workspaceName: EVIL, userLabel: EVIL, contactEmail: EVIL, message: `${EVIL}\nsecond line\r\nthird` });
    const html = sent[0].html;
    expect(html).not.toMatch(/<img|<a href="https:\/\/evil/);
    expect((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length).toBe(4);
    expect(html).toContain('second line<br>third');
    expect(sent[0].subject).not.toMatch(/[\r\n]/); // a subject is plain text: markup in it is harmless, a line break is not
  });

  test('a subject line stays one line', async () => {
    await sendSupportTicketEmail({ workspaceName: 'A\nB', userLabel: 'u', contactEmail: 'c@example.com', message: 'm' });
    expect(sent[0].subject).toBe('Support request from A B');
  });
});

describe('magic link e-mail', () => {
  test('the link is escaped inside its attribute and its text, so a crafted value cannot close the attribute', async () => {
    await sendMagicLinkEmail('a@example.com', 'https://app.example/auth/verify?token=abc" onmouseover="alert(1)');
    expect(sent[0].html).not.toContain('" onmouseover="');
    expect(sent[0].html).toContain('&quot; onmouseover=&quot;');
  });

  test('an ordinary link is unchanged apart from the escaping of & in its query', async () => {
    await sendMagicLinkEmail('a@example.com', 'https://app.example/auth/verify?token=abc');
    expect(sent[0].html).toContain('<a href="https://app.example/auth/verify?token=abc">https://app.example/auth/verify?token=abc</a>');
  });
});
