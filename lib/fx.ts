/**
 * Indicative FX helpers (DEV_PLAN §2.19). Conversion is a *rendering* step:
 * the canonical amount in the group currency is what gets stored and charged,
 * so nothing here ever feeds a checkout.
 */

import { getLocales } from 'expo-localization';

import { currencyExponent } from './money';

export type FxSnapshot = {
  base: string;
  asOf: string;
  source: string;
  /** The upstream fetch failed and these are the last known good rates. */
  stale: boolean;
  /** Units of quote per 1 base; `rates[base]` is always 1. */
  rates: Record<string, number>;
};

/** Units of `to` per one unit of `from`, or null when either side is missing. */
export function crossRate(
  rates: Record<string, number> | null | undefined,
  from: string,
  to: string
): number | null {
  if (!rates) return null;
  const source = from.trim().toUpperCase();
  const target = to.trim().toUpperCase();
  if (source === target) return 1;

  const fromRate = rates[source];
  const toRate = rates[target];
  if (!fromRate || !toRate) return null;

  const rate = toRate / fromRate;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Same major-unit value, re-expressed in another currency's minor units.
 * Keeps the exponent difference inside integer arithmetic (§2.19 rate math).
 */
export function convertMinor(
  amountMinor: number,
  from: string,
  to: string,
  rates: Record<string, number> | null | undefined
): number | null {
  const rate = crossRate(rates, from, to);
  if (rate === null) return null;

  const shift = 10 ** (currencyExponent(to) - currencyExponent(from));
  return Math.round(amountMinor * rate * shift);
}

/**
 * Rate display: enough digits that 0.02945 and 0.02950 do not look identical.
 */
export function formatRate(rate: number): string {
  if (rate >= 100) return rate.toFixed(0);
  if (rate >= 1) return rate.toFixed(3);
  return rate.toFixed(5);
}

/**
 * The device's own currency. iOS/Android report it directly; the web platform
 * returns null (see expo-localization), so web falls through to the group
 * currency rather than guessing from a region lookup table.
 */
export function deviceCurrency(): string | null {
  try {
    const code = getLocales()[0]?.currencyCode;
    return code && /^[A-Z]{3}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
