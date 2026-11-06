/**
 * All money in Globie Keeper is stored and transported as integer minor units
 * (cents/satang). Never do arithmetic on floats.
 */

/**
 * ISO-4217 minor-unit exponents. Anything absent from both sets uses 2, which
 * covers most currencies. This must stay in step with `currencyExponent()` in
 * `server/src/lib/paypal.ts`.
 */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function toMinor(input: string | number, exponent = 2): number {
  const raw = typeof input === 'number' ? input.toFixed(exponent) : input.trim();
  if (!/^-?\d*(\.\d*)?$/.test(raw)) return NaN;
  const negative = raw.startsWith('-');
  const [whole = '0', frac = ''] = raw.replace('-', '').split('.');
  const padded = (frac + '0'.repeat(exponent)).slice(0, exponent);
  const value = Number(whole || '0') * 10 ** exponent + Number(padded || '0');
  return negative ? -value : value;
}

export function fromMinor(amountMinor: number, exponent = 2): number {
  return amountMinor / 10 ** exponent;
}

export function formatMinor(
  amountMinor: number,
  currency: string,
  locale?: string
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(fromMinor(amountMinor, currencyExponent(currency)));
}

export function sumMinor(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
