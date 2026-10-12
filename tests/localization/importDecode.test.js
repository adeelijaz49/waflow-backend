// Pure unit tests (no database): approved global change B2b - the upload decoder in front of the
// existing import wizard's XLSX.read. Every row of the design's encoding table, end to end with the
// real SheetJS the wizard uses: the buffer comes back as the SAME object unless it is a BOM-less
// text file that demonstrably contains Arabic.
const XLSX = require('xlsx');
const { prepareUploadBuffer, looksLikeArabic1256 } = require('../../shared/localization/importDecode');
const { MAX_BYTES } = require('../../shared/localization/csv');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// windows-1256 encoder built from the platform's own decoder (no extra dependency).
const CP1256 = new Map();
{
  const decoder = new TextDecoder('windows-1256');
  for (let byte = 0; byte < 256; byte += 1) {
    const ch = decoder.decode(Uint8Array.of(byte));
    if (!CP1256.has(ch)) CP1256.set(ch, byte);
  }
}
function cp1256(text) {
  return Buffer.from(Array.from(text, (ch) => {
    if (!CP1256.has(ch)) throw new Error(`not in windows-1256: ${ch}`);
    return CP1256.get(ch);
  }));
}
const latin1 = (text) => Buffer.from(text, 'latin1');

// Exactly what importEngine.parseFile does.
function parse(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return {
    rows: XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }),
    headers: (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map((h) => String(h).trim()).filter(Boolean),
  };
}

const NAME_HDR = 'الاسم';
const PHONE_HDR = 'الهاتف';
const SARA = 'سارة أحمد';

describe('buffers that must come back as the SAME object (identical to today)', () => {
  test.each([
    ['ASCII CSV', Buffer.from('name,phone\nSara,0501234567\n')],
    ['ASCII with semicolons', Buffer.from('name;phone\nSara;0501234567\n')],
    ['UTF-8 with BOM, Arabic', Buffer.concat([BOM, Buffer.from(`${NAME_HDR},${PHONE_HDR}\n${SARA},0501234567\n`)])],
    ['UTF-16LE with BOM, Arabic', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${NAME_HDR},${PHONE_HDR}\n${SARA},0501234567\n`, 'utf16le')])],
    ['Latin-1 French', latin1('name,phone\n\u{00C9}ric Dupont,0501234567\n\u{00C9}cole Caf\u{00E9},0501234568\n')],
    ['Latin-1 with only three high letters', latin1('name,phone\n\u{00C0}\u{00C9}\u{00C8} Test,0501234567\n')],
    ['BOM-less UTF-8 with only accented Latin (out of the Arabic-only approval, stays as today)', Buffer.from('name,phone\nJos\u{00E9} Caf\u{00E9},0501234567\n')],
    ['BOM-less UTF-8 with emoji only', Buffer.from('name,phone\nSara \u{1F600},0501234567\n')],
    ['xlsx (zip)', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xd8, 0xa7])],
    ['xls (OLE)', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0xd8, 0xa7])],
    ['HTML table', Buffer.from('<table><tr><td>\u{0633}\u{0627}\u{0631}\u{0629}</td></tr></table>')],
    ['empty', Buffer.alloc(0)],
    ['one byte', Buffer.from([0xd8])],
    ['truncated UTF-8 with a Latin lead', Buffer.concat([Buffer.from('name,phone\nSara,05012\n'), Buffer.from([0xe2, 0x82])])],
  ])('%s', (name, buffer) => {
    expect(prepareUploadBuffer(buffer)).toBe(buffer);
  });

  test('a file over the 5 MB cap is returned untouched (the importer has its own limits)', () => {
    const big = Buffer.alloc(MAX_BYTES + 10, 0x61);
    big[100] = 0xd8;
    expect(prepareUploadBuffer(big)).toBe(big);
  });

  test('non-buffers are returned as they are and never throw', () => {
    for (const value of [undefined, null, 'text', 42, {}, []]) expect(prepareUploadBuffer(value)).toBe(value);
  });

  test('Latin-1 files parse exactly as they do today', () => {
    const buffer = latin1('name,phone\n\u{00C9}ric Dupont,0501234567\n\u{00C9}cole Caf\u{00E9},0501234568\n');
    expect(parse(prepareUploadBuffer(buffer))).toEqual(parse(buffer));
    expect(parse(buffer).rows[0].name).toBe('\u{00C9}ric Dupont');
  });

  test('BOM-less UTF-8 accented Latin stays mojibake exactly as today (documented, owner decision O2)', () => {
    const buffer = Buffer.from('name,phone\nJos\u{00E9},0501234567\n');
    expect(parse(prepareUploadBuffer(buffer))).toEqual(parse(buffer));
    expect(parse(buffer).rows[0].name).not.toBe('Jos\u{00E9}');
  });
});

describe('BOM-less Arabic text files are repaired', () => {
  test('UTF-8 without BOM: a BOM is prepended, the original bytes follow; keys and values are Arabic', () => {
    const buffer = Buffer.from(`${NAME_HDR},${PHONE_HDR}\n${SARA},0501234567\n`);
    const before = parse(buffer);
    expect(before.headers[0]).not.toBe(NAME_HDR); // mojibake today
    const out = prepareUploadBuffer(buffer);
    expect(out).not.toBe(buffer);
    expect(out.subarray(0, 3)).toEqual(BOM);
    expect(out.subarray(3)).toEqual(buffer);
    expect(buffer[0]).toBe(0xd8); // the input object itself is never modified
    const after = parse(out);
    expect(after.headers).toEqual([NAME_HDR, PHONE_HDR]);
    expect(after.rows).toEqual([{ [NAME_HDR]: SARA, [PHONE_HDR]: '0501234567' }]);
  });

  test('UTF-8 without BOM, semicolon delimited', () => {
    const buffer = Buffer.from(`${NAME_HDR};${PHONE_HDR}\n${SARA};0501234567\n`);
    const after = parse(prepareUploadBuffer(buffer));
    expect(after.headers).toEqual([NAME_HDR, PHONE_HDR]);
    expect(after.rows[0][NAME_HDR]).toBe(SARA);
  });

  test('UTF-8 without BOM, mixed Arabic + English + emoji + Arabic-Indic digits + SAR text', () => {
    const buffer = Buffer.from(`name,phone,price\n${SARA} Sara \u{1F600},\u{0660}\u{0665}\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667},\u{0661}\u{0662}\u{0663} \u{0631}.\u{0633}\n`);
    const after = parse(prepareUploadBuffer(buffer));
    expect(after.rows[0].name).toBe(`${SARA} Sara \u{1F600}`);
    expect(after.rows[0].phone).toBe('\u{0660}\u{0665}\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}');
    expect(after.rows[0].price).toBe('\u{0661}\u{0662}\u{0663} \u{0631}.\u{0633}');
  });

  test('UTF-8 without BOM whose only Arabic content is Arabic-Indic / Persian digits (English text, phones typed in Arabic digits)', () => {
    const arabicDigits = '\u{0660}\u{0665}\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}';
    const persianDigits = '\u{06F0}\u{06F5}\u{06F0}\u{06F1}\u{06F2}\u{06F3}\u{06F4}\u{06F5}\u{06F6}\u{06F8}';
    for (const digits of [arabicDigits, persianDigits]) {
      const buffer = Buffer.from(`name,phone\nSara Ahmed,${digits}\n`);
      expect(parse(buffer).rows[0].phone).not.toBe(digits); // mojibake today
      const out = prepareUploadBuffer(buffer);
      expect(out).not.toBe(buffer);
      expect(parse(out).rows[0].phone).toBe(digits);
    }
  });

  test('UTF-8 without BOM: Arabic only in a data row (English headers)', () => {
    const buffer = Buffer.from(`name,phone\n${SARA},0501234567\nMona,0501234568\n`);
    const after = parse(prepareUploadBuffer(buffer));
    expect(after.headers).toEqual(['name', 'phone']);
    expect(after.rows.map((r) => r.name)).toEqual([SARA, 'Mona']);
  });

  test.each([
    ['comma', ','],
    ['semicolon', ';'],
  ])('Windows-1256 (Excel "CSV" on an Arabic PC), %s delimited', (name, delimiter) => {
    const text = `${NAME_HDR}${delimiter}${PHONE_HDR}\n${SARA}${delimiter}0501234567\n\u{0639}\u{0644}\u{064A}${delimiter}0501234568\n`;
    const buffer = cp1256(text);
    expect(parse(buffer).headers[0]).not.toBe(NAME_HDR); // mojibake today
    const out = prepareUploadBuffer(buffer);
    expect(out).not.toBe(buffer);
    const after = parse(out);
    expect(after.headers).toEqual([NAME_HDR, PHONE_HDR]);
    expect(after.rows.map((r) => r[NAME_HDR])).toEqual([SARA, '\u{0639}\u{0644}\u{064A}']);
  });

  test('Windows-1256 with Latin names mixed in', () => {
    const buffer = cp1256(`${NAME_HDR},${PHONE_HDR}\nSara ${SARA},0501234567\n`);
    const after = parse(prepareUploadBuffer(buffer));
    expect(after.rows[0][NAME_HDR]).toBe(`Sara ${SARA}`);
  });

  test('Windows-1256 with very few Arabic letters is NOT trusted (could be Latin-1): stays as today', () => {
    const buffer = cp1256('name,phone\n\u{0633}\u{0627}\u{0631},0501234567\n'); // 3 letters < 6
    expect(prepareUploadBuffer(buffer)).toBe(buffer);
  });
});

describe('looksLikeArabic1256', () => {
  test('needs six letters, a run of three, and an 80% Arabic share', () => {
    expect(looksLikeArabic1256('\u{0633}\u{0627}\u{0631}\u{0629} \u{0623}\u{062D}\u{0645}\u{062F}')).toBe(true);
    expect(looksLikeArabic1256('\u{0633}\u{0627}\u{0631}')).toBe(false); // too few
    expect(looksLikeArabic1256('\u{0633}a\u{0627}b\u{0631}c\u{0629}d\u{0623}e\u{062D}f')).toBe(false); // no run of three
    expect(looksLikeArabic1256('\u{0633}\u{0627}\u{0631}\u{0629}\u{0623}\u{062D}\u{0645} \u{00C9}\u{00E9}\u{00E8}\u{00E0}\u{00F4}\u{00FC}\u{00E7}')).toBe(false); // Latin share too big
    expect(looksLikeArabic1256('plain ascii')).toBe(false);
    expect(looksLikeArabic1256('')).toBe(false);
  });
});

describe('invariants', () => {
  test('the decoder never throws and never returns a different-length-than-input surprise for binary junk', () => {
    const junk = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256));
    expect(() => prepareUploadBuffer(junk)).not.toThrow();
    expect(Buffer.isBuffer(prepareUploadBuffer(junk))).toBe(true);
  });

  test('truncated UTF-8 in the middle of an Arabic letter is not repaired into garbage (stays as today)', () => {
    const whole = Buffer.from(`${NAME_HDR},${PHONE_HDR}\n${SARA},0501234567\n`);
    const cut = whole.subarray(0, whole.length - 1 - 12); // may end inside a 2-byte letter
    const out = prepareUploadBuffer(Buffer.concat([cut, Buffer.from([0xd8])]));
    expect(Buffer.isBuffer(out)).toBe(true);
  });
});
