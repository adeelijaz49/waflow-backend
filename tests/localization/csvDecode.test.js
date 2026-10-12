const express = require('express');
const request = require('supertest');
const { decodeCsvBuffer, parseCsv, BOM } = require('../../shared/localization/csv');
const { csvUpload, parseBooleanField } = require('../../shared/localization/upload');

const ARABIC = 'مرحبا';

describe('decodeCsvBuffer', () => {
  test('UTF-8 with BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`phone,language\n1,${ARABIC}`, 'utf8')]);
    expect(decodeCsvBuffer(buf)).toEqual({ text: `phone,language\n1,${ARABIC}`, encoding: 'utf-8-bom' });
  });

  test('UTF-8 without BOM (Google Sheets / LibreOffice)', () => {
    const res = decodeCsvBuffer(Buffer.from(`name\n${ARABIC}`, 'utf8'));
    expect(res.encoding).toBe('utf-8');
    expect(res.text).toBe(`name\n${ARABIC}`);
  });

  test('UTF-16LE with BOM (Excel "Unicode Text")', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`name\t${ARABIC}`, 'utf16le')]);
    const res = decodeCsvBuffer(buf);
    expect(res.encoding).toBe('utf-16le');
    expect(res.text).toBe(`name\t${ARABIC}`);
  });

  test('Windows-1256 (Excel "CSV" on an Arabic-locale PC) is decoded, not turned into mojibake', () => {
    // "مرحبا" in windows-1256: E3 D1 CD C8 C7
    const buf = Buffer.concat([Buffer.from('name\n', 'latin1'), Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7])]);
    const res = decodeCsvBuffer(buf);
    expect(res.encoding).toBe('windows-1256');
    expect(res.text).toBe(`name\n${ARABIC}`);
  });

  test('empty files and spreadsheets are rejected with FILE_INVALID', () => {
    expect(() => decodeCsvBuffer(Buffer.alloc(0))).toThrow(/empty/);
    const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    try { decodeCsvBuffer(xlsx); throw new Error('should have thrown'); } catch (e) { expect(e.code).toBe('FILE_INVALID'); expect(e.status).toBe(400); }
  });

  test('decoded text parses with the shared CSV reader', () => {
    const { text } = decodeCsvBuffer(Buffer.from(`${BOM}phone;language\n966500000001;ar`, 'utf8'));
    expect(parseCsv(text).rows[0]).toEqual({ _line: 2, phone: '966500000001', language: 'ar' });
  });
});

describe('csvUpload middleware', () => {
  function app() {
    const a = express();
    a.post('/up', csvUpload('file'), (req, res) => res.json({ size: req.file.size, name: req.file.originalname, dryRun: parseBooleanField(req.body.dryRun) }));
    return a;
  }

  test('accepts a CSV and exposes text fields', async () => {
    const res = await request(app()).post('/up').field('dryRun', 'true').attach('file', Buffer.from('a,b\n1,2'), 'x.csv');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ size: 7, name: 'x.csv', dryRun: true });
  });

  test('no file -> 400 FILE_REQUIRED', async () => {
    const res = await request(app()).post('/up').field('dryRun', 'false');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
  });

  test('wrong type -> 400 FILE_INVALID', async () => {
    const res = await request(app()).post('/up').attach('file', Buffer.from('x'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_INVALID');
  });

  test('over 5 MB -> 413 FILE_TOO_LARGE', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 97);
    const res = await request(app()).post('/up').attach('file', big, 'big.csv');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  test('parseBooleanField', () => {
    expect(['true', '1', 'YES', 'on'].map(parseBooleanField)).toEqual([true, true, true, true]);
    expect([undefined, '', 'false', '0', 'no'].map(parseBooleanField)).toEqual([false, false, false, false, false]);
  });
});
