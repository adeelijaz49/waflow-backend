'use strict';
// Small RFC 4180 CSV reader/writer shared by the localisation features (native
// review export/import, customer-language import, Arabic product/service names).
// No dependencies. Handles a UTF-8 BOM, CRLF/LF/CR, quoted fields containing
// delimiters / quotes / newlines, comma|semicolon|tab delimiters (Excel in
// Arabic-locale Windows writes semicolons), and spreadsheet-formula neutralising
// on export.
const BOM = '\u{FEFF}';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 50000;

function detectDelimiter(text) {
  const firstLine = (text.split(/\r\n|\n|\r/, 1)[0] || '');
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

function fileError(message, code, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Uploaded bytes -> text. Real-world Arabic CSV files arrive in four encodings:
// UTF-8 with BOM (Excel "CSV UTF-8"), UTF-8 without BOM (Google Sheets, LibreOffice),
// UTF-16 with BOM (Excel "Unicode Text") and Windows-1256 (Excel "CSV (Comma
// delimited)" on an Arabic-locale Windows PC — decoded as Latin-1 it turns every
// Arabic name into mojibake). Returns { text, encoding }; throws a 400
// FILE_INVALID for empty files and for spreadsheets (.xlsx are zip files).
function decodeCsvBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fileError('The file is empty', 'FILE_INVALID');
  if (buffer.length > MAX_BYTES) throw fileError('CSV file is too large (max 5 MB)', 'FILE_TOO_LARGE', 413);
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    throw fileError('Spreadsheet files are not supported here — save the sheet as CSV (UTF-8)', 'FILE_INVALID');
  }
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch (err) {
    return { text: new TextDecoder('windows-1256').decode(buffer), encoding: 'windows-1256' };
  }
}

// -> string[][] (rows of cells). Throws Error with status 400 on malformed/oversized input.
function parseRows(input, { delimiter } = {}) {
  let text = input === undefined || input === null ? '' : String(input);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) { const e = new Error('CSV file is too large (max 5 MB)'); e.status = 400; throw e; }
  if (text.startsWith(BOM)) text = text.slice(BOM.length);
  const delim = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // skip fully empty lines
    row = [];
    if (rows.length > MAX_ROWS) { const e = new Error(`CSV has too many rows (max ${MAX_ROWS})`); e.status = 400; throw e; }
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      cell += c; i += 1; continue;
    }
    if (c === '"' && cell === '') { inQuotes = true; i += 1; continue; }
    if (c === delim) { pushCell(); i += 1; continue; }
    if (c === '\r') { pushRow(); i += text[i + 1] === '\n' ? 2 : 1; continue; }
    if (c === '\n') { pushRow(); i += 1; continue; }
    cell += c; i += 1;
  }
  if (inQuotes) { const e = new Error('CSV has an unterminated quoted field'); e.status = 400; throw e; }
  if (cell !== '' || row.length) pushRow();
  return rows;
}

// -> { headers: string[] (trimmed, lower-cased keys), rows: object[] } — each
// row object is keyed by the lower-cased header; `_line` is the 1-based CSV line.
function parseCsv(input, opts = {}) {
  const raw = parseRows(input, opts);
  if (!raw.length) return { headers: [], rows: [] };
  const headers = raw[0].map((h) => String(h).trim().toLowerCase());
  const rows = raw.slice(1).map((cells, idx) => {
    const obj = { _line: idx + 2 };
    headers.forEach((h, k) => { if (h) obj[h] = cells[k] === undefined ? '' : cells[k]; });
    return obj;
  });
  return { headers, rows };
}

// Cells that a spreadsheet could interpret as a formula get a leading quote.
function neutralize(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /^[=+\-@]/.test(s) && !/^[+-]?\d/.test(s) ? `'${s}` : s;
}
function un_neutralize(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function quote(value, delimiter) {
  const s = value === undefined || value === null ? '' : String(value);
  return /["\r\n]/.test(s) || s.includes(delimiter) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rows: array of arrays. Excel-friendly: BOM + CRLF.
function stringifyCsv(rows, { delimiter = ',', bom = true, neutralizeFormulas = true } = {}) {
  const body = rows
    .map((r) => r.map((cell) => quote(neutralizeFormulas ? neutralize(cell) : cell, delimiter)).join(delimiter))
    .join('\r\n');
  return `${bom ? BOM : ''}${body}\r\n`;
}

module.exports = { BOM, MAX_BYTES, MAX_ROWS, detectDelimiter, decodeCsvBuffer, parseRows, parseCsv, stringifyCsv, neutralize, un_neutralize };
