// Pure unit tests (no database) — opt-out / opt-in keyword recognition, spec §3.4:
// "Add automated tests for each keyword and each normalisation case."
const { classifyInboundText, RAW, stripFillers } = require('../../shared/localization/keywords');

const kind = (text) => { const r = classifyInboundText(text); return r ? r.kind : null; };

describe('opt-out keywords (spec list) — every keyword', () => {
  test.each([
    ['STOP'], ['stop'], ['Stop'], ['UNSUBSCRIBE'],
    ['إلغاء الاشتراك'], ['إلغاء'], ['الغاء'], ['توقف'], ['ايقاف'], ['إيقاف'],
  ])('"%s" is an opt-out', (text) => {
    expect(kind(text)).toBe('opt_out');
  });

  test('every entry of the raw opt-out list is recognised', () => {
    for (const k of RAW.opt_out) expect(kind(k)).toBe('opt_out');
  });
});

describe('opt-out — each normalisation case', () => {
  test('tashkeel (diacritics)', () => {
    expect(kind('إِلْغَاءُ الاشْتِرَاكِ')).toBe('opt_out');
    expect(kind('تَوَقَّفْ')).toBe('opt_out');
    expect(kind('إِيقَاف')).toBe('opt_out');
  });
  test('tatweel (kashida)', () => {
    expect(kind('إلغـــاء')).toBe('opt_out');
    expect(kind('تـــوقـــف')).toBe('opt_out');
  });
  test('alef variants and hamza spelling', () => {
    expect(kind('ألغاء')).toBe('opt_out');
    expect(kind('آلغاء الاشتراك')).toBe('opt_out');
    expect(kind('إلغاء الإشتراك')).toBe('opt_out');
    expect(kind('ايقاف')).toBe('opt_out'); // ايقاف
  });
  test('trailing punctuation, emoji and decoration', () => {
    expect(kind('توقف!!!')).toBe('opt_out');
    expect(kind('توقف.')).toBe('opt_out');
    expect(kind('إلغاء الاشتراك؟')).toBe('opt_out');
    expect(kind('«إلغاء الاشتراك»')).toBe('opt_out');
    expect(kind('توقف 🛑')).toBe('opt_out');
    expect(kind('🛑 STOP')).toBe('opt_out');
  });
  test('invisible bidi marks from RTL keyboards', () => {
    expect(kind('\u{200F}توقف\u{200F}')).toBe('opt_out');
    expect(kind('\u{202B}توقف\u{202C}')).toBe('opt_out');
  });
  test('extra whitespace and line breaks', () => {
    expect(kind('  إلغاء   الاشتراك  ')).toBe('opt_out');
    expect(kind('إلغاء\nالاشتراك')).toBe('opt_out');
  });
  test('Arabic-Indic digits do not interfere (digits are converted, text still matches)', () => {
    expect(kind('توقف ٠')).toBeNull(); // a stray digit makes it a different message
  });
  test('polite filler words around the keyword', () => {
    expect(kind('توقف من فضلك')).toBe('opt_out');
    expect(kind('لو سمحت الغاء الاشتراك')).toBe('opt_out');
    expect(kind('الغاء الاشتراك شكرا')).toBe('opt_out');
    expect(kind('please stop')).toBe('opt_out');
  });
});

describe('opt-out — things that must NOT opt anyone out', () => {
  test.each([
    ['لا تتوقف الخدمة عندكم؟'],
    ['توقف الطلب عند الباب'],
    ['متى توقف العرض؟'],
    ['أبدًا'],
    ['شكرا لكم'],
    ['Please do not stop the delivery'],
    ['مرحبا'],
    ['كم سعر الباقة؟'],
    [''],
    ['   '],
  ])('"%s" is not an opt-out', (text) => {
    expect(kind(text)).not.toBe('opt_out');
  });

  test('long messages are conversation, never commands', () => {
    expect(classifyInboundText(`توقف ${'كلمة '.repeat(30)}`)).toBeNull();
  });
});

describe('opt-in style replies (the hook only acts on them when an ask is pending)', () => {
  test.each([['نعم'], ['موافق'], ['أوافق'], ['نعم، أوافق'], ['نعم أوافق'], ['موافقة'], ['موافقه'], ['نَعَم']])('"%s" affirms', (t) => {
    expect(kind(t)).toBe('affirm');
  });
  test.each([['اشترك'], ['اشتراك'], ['SUBSCRIBE'], ['START'], ['تفعيل']])('"%s" is subscribe/start', (t) => {
    expect(kind(t)).toBe('subscribe');
  });
  test.each([['لا'], ['لا شكرا'], ['لا، شكرًا'], ['غير موافق']])('"%s" declines', (t) => {
    expect(kind(t)).toBe('decline');
  });
  test('أبدًا ("never") must never read as start', () => {
    expect(kind('أبدًا')).toBeNull();
    expect(kind('ابدا')).toBeNull();
  });
});

describe('classifyInboundText details', () => {
  test('reports whether the keyword was written in Arabic', () => {
    expect(classifyInboundText('توقف')).toMatchObject({ kind: 'opt_out', isArabic: true });
    expect(classifyInboundText('STOP')).toMatchObject({ kind: 'opt_out', isArabic: false });
  });
  test('stripFillers keeps meaning words', () => {
    expect(stripFillers('توقف من فضلك')).toBe('توقف');
    expect(stripFillers('توقف')).toBe('توقف');
  });
});
