// Formats an amount for WhatsApp message bodies. Angular's CurrencyPipe already
// handles proper symbol/locale formatting on the frontend — this only needs to
// cover the currencies this merchant base actually uses in outbound text.
const CURRENCIES = {
  AUD: { symbol: '$',   position: 'prefix' },
  USD: { symbol: '$',   position: 'prefix' },
  GBP: { symbol: '£',   position: 'prefix' },
  EUR: { symbol: '€',   position: 'prefix' },
  SAR: { symbol: 'SAR', position: 'suffix' },
  AED: { symbol: 'AED', position: 'suffix' },
};

function symbolFor(code) {
  return (CURRENCIES[code] || { symbol: code }).symbol;
}

function money(amount, code) {
  const cfg = CURRENCIES[code] || { symbol: code, position: 'suffix' };
  const formatted = Number(amount).toFixed(2);
  return cfg.position === 'prefix' ? `${cfg.symbol}${formatted}` : `${formatted} ${cfg.symbol}`;
}

// Reverse direction — parses a merchant-typed price cell tolerant of currency
// symbols/codes and thousands separators ("SAR 1,234.50", "$99", "1200") into
// a plain Number. Used by the CSV import engine's price-column validation.
function parsePrice(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[^\d.-]/g, ''); // strips symbols, currency codes, commas, spaces
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

module.exports = { symbolFor, money, parsePrice };
