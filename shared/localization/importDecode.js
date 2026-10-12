'use strict';
// Upload decoding for the EXISTING customer/product/service import wizard
// (shared/importEngine.js parseFile -> XLSX.read(buffer)). Approved global change B2b.
//
// Problem: SheetJS decodes a text file that has no byte-order mark as a single-byte
// legacy code page, so a BOM-less UTF-8 Arabic CSV ("الاسم,الهاتف") turns into mojibake
// keys and values, and a Windows-1256 CSV (what Excel on Arabic Windows saves as "CSV")
// turns into different mojibake.
//
// prepareUploadBuffer(buffer) is called in front of the unchanged XLSX.read. It returns
// THE SAME Buffer object (===) in every case except a BOM-less text file that
// demonstrably contains Arabic; then it returns a UTF-8-with-BOM buffer, which the
// existing XLSX.read path already decodes correctly.
//
// Rules, in order (any throw -> the input comes back untouched):
//  1. not a Buffer, fewer than 2 bytes, or bigger than the CSV helper's 5 MB cap -> as is
//  2. a known container / marked encoding (zip "PK" = xlsx, OLE = xls, UTF-8 BOM,
//     UTF-16 BOM, "<" = HTML / SpreadsheetML) -> as is
//  3. pure ASCII (no byte >= 0x80) -> as is
//  4. strictly valid UTF-8: with an Arabic letter or an Arabic-Indic / Persian digit -> BOM prepended,
//     otherwise as is
//     (a BOM-less UTF-8 file with only accented Latin letters stays exactly as today)
//  5. not valid UTF-8 -> decoded as windows-1256 by the shared helper and accepted ONLY
//     when it clearly is Arabic (looksLikeArabic1256); otherwise as is, so a Latin-1
//     French / Spanish file keeps working exactly as it does today.
const { decodeCsvBuffer, MAX_BYTES } = require('./csv');
const { isArabicLetter } = require('./arabicText');

const MIN_ARABIC_LETTERS = 6;
const MIN_ARABIC_RUN = 3;
const MIN_ARABIC_SHARE = 0.8;

// Arabic-Indic (U+0660..0669) and Extended / Persian (U+06F0..06F9) digits: a BOM-less UTF-8 file whose only
// non-ASCII text is such digits (English headers, phone numbers typed in Arabic digits) is just as broken
// today (the digits turn into mojibake and the phone is rejected) as one with Arabic letters.
const isArabicDigit = (ch) => /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u.test(ch);

function hasHighByte(buffer) {
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] >= 0x80) return true;
  return false;
}

function startsWithKnownContainer(buffer) {
  const b0 = buffer[0];
  const b1 = buffer[1];
  return (b0 === 0x50 && b1 === 0x4b) // zip (xlsx)
    || (b0 === 0xd0 && b1 === 0xcf) // OLE (xls)
    || (b0 === 0xef && b1 === 0xbb) // UTF-8 BOM
    || (b0 === 0xff && b1 === 0xfe) // UTF-16 LE BOM
    || (b0 === 0xfe && b1 === 0xff) // UTF-16 BE BOM
    || b0 === 0x3c; // '<' (HTML / SpreadsheetML)
}

// Windows-1256 acceptance: at least six Arabic letters, a run of three or more in a
// row, and Arabic letters at least 80% of all non-ASCII letters. A Latin-1 file decoded
// as cp1256 produces scattered Arabic letters between ASCII text, never a run.
function looksLikeArabic1256(text) {
  let arabic = 0;
  let otherLetters = 0;
  let run = 0;
  let longest = 0;
  for (const ch of String(text)) {
    if (isArabicLetter(ch)) {
      arabic += 1;
      run += 1;
      if (run > longest) longest = run;
      continue;
    }
    run = 0;
    if (ch.codePointAt(0) > 0x7f && /\p{L}/u.test(ch)) otherLetters += 1;
  }
  return arabic >= MIN_ARABIC_LETTERS && longest >= MIN_ARABIC_RUN && arabic / (arabic + otherLetters) >= MIN_ARABIC_SHARE;
}

function prepareUploadBuffer(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_BYTES) return buffer;
    if (startsWithKnownContainer(buffer) || !hasHighByte(buffer)) return buffer;
    const { text, encoding } = decodeCsvBuffer(buffer);
    if (encoding === 'utf-8') {
      for (const ch of text) if (isArabicLetter(ch) || isArabicDigit(ch)) return Buffer.concat([BOM_BYTES, buffer]);
      return buffer;
    }
    if (encoding === 'windows-1256' && looksLikeArabic1256(text)) {
      return Buffer.concat([BOM_BYTES, Buffer.from(text, 'utf8')]);
    }
    return buffer;
  } catch (err) {
    return buffer;
  }
}

const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

module.exports = { prepareUploadBuffer, looksLikeArabic1256 };
