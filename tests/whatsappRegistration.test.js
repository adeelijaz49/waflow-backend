// shared/whatsappRegistration.js: what Meta's phone-number `status` says about whether WhatsApp will accept sends from the number.
const { registrationOf, registrationMessage } = require('../shared/whatsappRegistration');

describe('registrationOf', () => {
  test.each([
    ['CONNECTED', 'CONNECTED', true],
    ['  connected ', 'CONNECTED', true],
    ['Connected', 'CONNECTED', true],
    ['PENDING', 'PENDING', false],
    ['pending', 'PENDING', false],
    ['\tUnverified\n', 'UNVERIFIED', false],
    ['UNVERIFIED', 'UNVERIFIED', false],
    // quality / limit states and other problems do not say "not registered": no claim either way
    ['FLAGGED', 'FLAGGED', null],
    ['RESTRICTED', 'RESTRICTED', null],
    ['DISCONNECTED', 'DISCONNECTED', null],
    ['OFFLINE', 'OFFLINE', null],
    ['MIGRATED', 'MIGRATED', null],
    ['DELETED', 'DELETED', null],
    ['BANNED', 'BANNED', null],
    ['UNKNOWN', 'UNKNOWN', null],
  ])('status %j -> status %s, registered %s', (given, status, registered) => {
    expect(registrationOf({ status: given })).toEqual({ status, registered });
  });

  test.each([
    ['empty string', ''],
    ['only spaces', '   '],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an object', { value: 'CONNECTED' }],
    ['an array', ['CONNECTED']],
    ['a boolean', true],
  ])('a status that is %s is "Meta did not say"', (_label, given) => {
    expect(registrationOf({ status: given })).toEqual({ status: null, registered: null });
  });

  test('no argument, null or an object without status is also "Meta did not say"', () => {
    for (const input of [undefined, null, {}, 'CONNECTED']) expect(registrationOf(input)).toEqual({ status: null, registered: null });
  });

  test('it returns a fresh object each time', () => {
    expect(registrationOf({ status: 'PENDING' })).not.toBe(registrationOf({ status: 'PENDING' }));
  });
});

describe('registrationMessage', () => {
  test('is the exact sentence, with Meta\'s word in upper case', () => {
    expect(registrationMessage('PENDING')).toBe(
      'Meta shows this number\'s status as PENDING, not CONNECTED, so it is not ready to send: WhatsApp is likely to refuse its messages with error 133010 (Account not registered). Check its status in Meta, then check again.',
    );
    expect(registrationMessage('  unverified ')).toContain('Meta shows this number\'s status as UNVERIFIED, not CONNECTED,');
  });

  test('it does not claim a certainty, and does not tell anyone to finish registering a number', () => {
    for (const given of ['PENDING', null]) {
      const text = registrationMessage(given);
      expect(text).toContain('likely to refuse');
      expect(text).not.toMatch(/refuses every|Finish registering|not registered with/);
    }
  });

  test('without a status it names no word instead of inventing one', () => {
    for (const none of [null, undefined, '', 7]) {
      const text = registrationMessage(none);
      expect(text).not.toContain('Meta shows');
      expect(text).toBe('Meta does not show this number as CONNECTED, so it is not ready to send: WhatsApp is likely to refuse its messages with error 133010 (Account not registered). Check its status in Meta, then check again.');
    }
  });
});
