'use strict';
// Unit tests for shared/platformAdmin.js: the SUPER_ADMIN_CONTACTS allowlist, contact validation and masking. Pure: no database.
const pa = require('../shared/platformAdmin');

const ENV_KEYS = ['SUPER_ADMIN_CONTACTS', 'ALLOW_SELF_SERVE_SIGNUP'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('normalisers', () => {
  test('normalizePhone keeps digits only and accepts Arabic-Indic digits', () => {
    expect(pa.normalizePhone('+61 (422) 286-126')).toBe('61422286126');
    expect(pa.normalizePhone('٩٦٦٥٠١٢٣٤٥٦٧')).toBe('966501234567');
    expect(pa.normalizePhone(null)).toBe('');
    expect(pa.normalizePhone(undefined)).toBe('');
    expect(pa.normalizePhone('abc')).toBe('');
  });

  test('normalizeEmail trims and lowercases', () => {
    expect(pa.normalizeEmail('  Boss@Example.COM ')).toBe('boss@example.com');
    expect(pa.normalizeEmail(undefined)).toBe('');
  });
});

describe('parseSuperAdminContacts', () => {
  test('empty / unset / whitespace-only / separators-only give no contacts', () => {
    for (const raw of [undefined, null, '', '   ', ' , ;; ,\n']) {
      const out = pa.parseSuperAdminContacts(raw);
      expect(out.phones.size).toBe(0);
      expect(out.emails.size).toBe(0);
    }
  });

  test('splits on commas, semicolons and newlines, NOT on spaces inside a phone number', () => {
    const out = pa.parseSuperAdminContacts('+61 422 286 126, Boss@Example.com;\n 966 50 123 4567 ,  ');
    expect([...out.phones].sort()).toEqual(['61422286126', '966501234567']);
    expect([...out.emails]).toEqual(['boss@example.com']);
  });

  test('an entry with an @ is an email even if it has digits; duplicates collapse', () => {
    const out = pa.parseSuperAdminContacts('12345678@x.com, 12345678@X.com, +1 555 0100, 15550100');
    expect([...out.emails]).toEqual(['12345678@x.com']);
    expect([...out.phones]).toEqual(['15550100']);
  });

  test('quotes around an entry (a value pasted into a dashboard with them) are not part of the contact', () => {
    const out = pa.parseSuperAdminContacts('"Boss@Example.com", \'+61 422 286 126\' ; \u{201C}a@b.co\u{201D}, `c@d.co`');
    expect([...out.emails].sort()).toEqual(['a@b.co', 'boss@example.com', 'c@d.co']);
    expect([...out.phones]).toEqual(['61422286126']);
  });

  test('invisible characters pasted along with an entry (zero-width space, left-to-right / right-to-left marks, byte-order mark) are dropped, also in the middle', () => {
    const zwsp = '\u{200B}'; const rlm = '\u{200F}'; const bom = '\u{FEFF}'; const lre = '\u{202A}';
    const out = pa.parseSuperAdminContacts(`${zwsp}Boss@Example.com${rlm}, ${bom}+61 422${zwsp} 286 126, ca${lre}rol@example.com`);
    expect([...out.emails].sort()).toEqual(['boss@example.com', 'carol@example.com']);
    expect([...out.phones]).toEqual(['61422286126']);
  });

  test('the quotes are also dropped when the list comes from the environment', () => {
    process.env.SUPER_ADMIN_CONTACTS = '"quoted.admin@example.com"';
    expect(pa.isSuperAdminContact({ email: 'Quoted.Admin@example.com' })).toBe(true);
  });

  test('an entry that is neither a plausible email nor a plausible phone number is reported once, masked - and the plausible ones still work', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const raw = 'carol@example.com, dave-typo@example, 12345, just words';
      const out = pa.parseSuperAdminContacts(raw);
      expect([...out.emails]).toEqual(['carol@example.com', 'dave-typo@example']); // what parsed before still parses the same
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toMatch(/3 of its entries/);
      expect(line).toContain('d***@e***'); // masked...
      expect(line).not.toMatch(/dave-typo|carol|12345|just words/); // ...never the contact itself
      pa.parseSuperAdminContacts(raw); // memoised: not said again
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  test('a list of plausible contacts is silent', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pa.parseSuperAdminContacts('erin@example.com; +966 50 123 4567');
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('is memoised on the raw string and re-parsed when it changes', () => {
    const a = pa.parseSuperAdminContacts('a@b.co');
    expect(pa.parseSuperAdminContacts('a@b.co')).toBe(a); // same object: not re-parsed
    const b = pa.parseSuperAdminContacts('c@d.co');
    expect(b).not.toBe(a);
    expect([...b.emails]).toEqual(['c@d.co']);
    expect(pa.parseSuperAdminContacts('a@b.co')).not.toBe(a); // memo holds the LAST raw only; the result is still correct
    expect([...pa.parseSuperAdminContacts('a@b.co').emails]).toEqual(['a@b.co']);
  });

  test('defaults to process.env.SUPER_ADMIN_CONTACTS read at call time', () => {
    expect(pa.isConfigured()).toBe(false);
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
    expect(pa.isConfigured()).toBe(true);
    process.env.SUPER_ADMIN_CONTACTS = '';
    expect(pa.isConfigured()).toBe(false);
  });
});

describe('isSuperAdminContact / isSuperAdminUser', () => {
  test('env empty: nobody is a super admin, whatever they present', () => {
    expect(pa.isSuperAdminContact({ phone: '61422286126', email: 'boss@example.com' })).toBe(false);
    expect(pa.isSuperAdminUser({ phone: '61422286126' })).toBe(false);
    expect(pa.isSuperAdminContact()).toBe(false);
    expect(pa.isSuperAdminContact({})).toBe(false);
  });

  test('a phone matches however it is formatted, an email matches case-insensitively', () => {
    process.env.SUPER_ADMIN_CONTACTS = '+61 422 286 126, Boss@Example.com';
    expect(pa.isSuperAdminContact({ phone: '61422286126' })).toBe(true);
    expect(pa.isSuperAdminContact({ phone: '+61-422-286-126' })).toBe(true);
    expect(pa.isSuperAdminContact({ email: 'BOSS@example.COM' })).toBe(true);
    expect(pa.isSuperAdminUser({ phone: '61422286126' })).toBe(true);
    expect(pa.isSuperAdminUser({ email: 'boss@example.com', name: 'x' })).toBe(true);
  });

  test('a phone number is not matched against emails, nor an email against phones; other people and blanks are refused', () => {
    process.env.SUPER_ADMIN_CONTACTS = '61422286126, boss@example.com';
    expect(pa.isSuperAdminContact({ phone: '61422286127' })).toBe(false);
    expect(pa.isSuperAdminContact({ email: 'boss2@example.com' })).toBe(false);
    expect(pa.isSuperAdminContact({ email: '61422286126' })).toBe(false);
    expect(pa.isSuperAdminContact({ phone: '', email: '' })).toBe(false);
    expect(pa.isSuperAdminUser(null)).toBe(false);
    expect(pa.isSuperAdminUser(undefined)).toBe(false);
  });

  test('a partial phone (a suffix of an allowed one) does not match', () => {
    process.env.SUPER_ADMIN_CONTACTS = '61422286126';
    expect(pa.isSuperAdminContact({ phone: '422286126' })).toBe(false);
    expect(pa.isSuperAdminContact({ phone: '9961422286126' })).toBe(false);
  });
});

describe('maskContact / maskUser', () => {
  test('emails keep the first letter of the name and of the domain, and the ending', () => {
    expect(pa.maskContact('andrew@domain.com')).toBe('a***@d***.com');
    expect(pa.maskContact('X@Y.co.uk')).toBe('X***@Y***.uk');
    expect(pa.maskContact('weird@nodot')).toBe('w***@n***');
  });

  test('phones keep only the last four digits', () => {
    expect(pa.maskContact('+966 50 123 1234')).toBe('******1234');
    expect(pa.maskContact('61422286126')).toBe('******6126');
    expect(pa.maskContact('1234')).toBe('****');
  });

  test('blank in, blank out; the full contact never appears in the mask', () => {
    expect(pa.maskContact('')).toBe('');
    expect(pa.maskContact(null)).toBe('');
    expect(pa.maskContact('someone@example.com')).not.toContain('someone');
    expect(pa.maskContact('966501234567')).not.toContain('96650');
    expect(pa.maskUser({ phone: '966501234567', email: 'a@b.co' })).toBe('******4567');
    expect(pa.maskUser({ email: 'a@b.co' })).toBe('a***@b***.co');
    expect(pa.maskUser(null)).toBe('');
  });
});

describe('normalizeContact (validation of what staff type)', () => {
  test('emails: lowercased and trimmed; garbage refused', () => {
    expect(pa.normalizeContact('email', '  Owner@Shop.COM ')).toEqual({ type: 'email', contact: 'owner@shop.com' });
    for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', '@c.com', 'a@.com', 'a@c..com', null, undefined, 'a@b@c.com']) {
      expect(pa.normalizeContact('email', bad)).toBeNull();
    }
  });

  test('phones: digits only, 8 to 15 of them; letters and too short / too long refused', () => {
    expect(pa.normalizeContact('phone', '+966 50 123 4567')).toEqual({ type: 'phone', contact: '966501234567' });
    expect(pa.normalizeContact('phone', '61422286126')).toEqual({ type: 'phone', contact: '61422286126' });
    for (const bad of ['', '1234567', '1234567890123456', '0501abc4567', 'owner@shop.com', null, undefined]) {
      expect(pa.normalizeContact('phone', bad)).toBeNull();
    }
  });

  test('an unknown type is refused', () => {
    expect(pa.normalizeContact('fax', '12345678')).toBeNull();
    expect(pa.normalizeContact(undefined, 'a@b.co')).toBeNull();
  });
});

describe('selfServeSignupAllowed', () => {
  test('unset or empty keeps sign-up open (the default); on / true / 1 / yes keep it open; off / false / 0 / no close it', () => {
    expect(pa.selfServeSignupAllowed()).toBe(true);
    for (const v of ['true', 'TRUE', ' true ', '1', 'yes', 'on', '']) {
      process.env.ALLOW_SELF_SERVE_SIGNUP = v;
      expect(pa.selfServeSignupAllowed()).toBe(true);
    }
    for (const v of ['false', 'FALSE', ' false ', '0', 'off', 'no']) {
      process.env.ALLOW_SELF_SERVE_SIGNUP = v;
      expect(pa.selfServeSignupAllowed()).toBe(false);
    }
  });

  test('a value that is not understood counts as OFF: a typo in the switch that closes sign-up must not leave sign-up open', () => {
    for (const v of ['flase', 'disabled', 'closed', 'n', 'anything', 'ture']) {
      process.env.ALLOW_SELF_SERVE_SIGNUP = v;
      expect(pa.selfServeSignupAllowed()).toBe(false);
    }
  });
});
