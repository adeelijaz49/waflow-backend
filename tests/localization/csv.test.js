const { parseCsv, parseRows, stringifyCsv, detectDelimiter, neutralize, un_neutralize, BOM } = require('../../shared/localization/csv');

describe('parseCsv', () => {
  test('headers are trimmed + lower-cased; rows are keyed objects with line numbers', () => {
    const { headers, rows } = parseCsv('Phone, Language \n+966500000001,ar\n+966500000002,English\n');
    expect(headers).toEqual(['phone', 'language']);
    expect(rows).toEqual([{ _line: 2, phone: '+966500000001', language: 'ar' }, { _line: 3, phone: '+966500000002', language: 'English' }]);
  });

  test('strips a UTF-8 BOM and handles CRLF, LF and CR endings', () => {
    expect(parseRows(`${BOM}a,b\r\n1,2\r\n`)).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseRows('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseRows('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  test('quoted fields: commas, doubled quotes and newlines inside quotes', () => {
    expect(parseRows('k,v\n"a,b","say ""hi"""\n"line1\nline2",x\n')).toEqual([['k', 'v'], ['a,b', 'say "hi"'], ['line1\nline2', 'x']]);
  });

  test('Arabic content and mixed scripts round-trip untouched', () => {
    const { rows } = parseCsv('key,english,arabic\nconsent.optOut,Opt Out,إلغاء الاشتراك\n');
    expect(rows[0].arabic).toBe('إلغاء الاشتراك');
  });

  test('delimiter auto-detection: semicolon (Arabic-locale Excel) and tab', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('a,b')).toBe(',');
    expect(parseCsv('phone;language\n123;ar').rows[0].language).toBe('ar');
  });

  test('skips blank lines and tolerates short rows', () => {
    const { rows } = parseCsv('a,b,c\n\n1,2\n\n');
    expect(rows).toEqual([{ _line: 2, a: '1', b: '2', c: '' }]);
  });

  test('unterminated quote and oversized input are rejected with a 400', () => {
    expect(() => parseRows('a,b\n"oops,1')).toThrow(/unterminated/);
    try { parseRows('a,"b'); } catch (e) { expect(e.status).toBe(400); }
    expect(() => parseRows('x'.repeat(5 * 1024 * 1024 + 1))).toThrow(/too large/);
  });

  test('empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});

describe('stringifyCsv', () => {
  test('BOM + CRLF, quotes only when needed, round-trips through parse', () => {
    const rows = [['key', 'english', 'arabic'], ['a.b', 'Hello, "world"', 'مرحبًا\nبكم'], ['c', ' padded ', '']];
    const csv = stringifyCsv(rows);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(parseRows(csv)).toEqual(rows);
  });

  test('neutralises spreadsheet formulas on export, and import undoes only that', () => {
    expect(neutralize('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralize('+cmd')).toBe("'+cmd");
    expect(neutralize('-5')).toBe('-5'); // plain numbers are left alone
    expect(neutralize('hello')).toBe('hello');
    expect(un_neutralize("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(un_neutralize("'quoted word")).toBe("'quoted word");
    expect(stringifyCsv([['=1+1']], { bom: false })).toBe("'=1+1\r\n");
  });

  test('can write semicolon-delimited files', () => {
    expect(stringifyCsv([['a', 'b;c']], { delimiter: ';', bom: false })).toBe('a;"b;c"\r\n');
  });
});
