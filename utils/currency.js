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

module.exports = { symbolFor, money };
