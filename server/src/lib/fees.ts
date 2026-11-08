/**
 * Optional fee coverage (DEV_PLAN §2.20).
 *
 * PayPal deducts its commercial fee from the payee, and Orders v2 has no
 * "the payer pays the fee" flag. The only way to make a fronter whole is to
 * ask the payer for a grossed-up amount: `net + estimated fee`.
 *
 * These figures are estimates — the real fee depends on payer country, payee
 * country, currency and whether the payment is cross-border. After capture the
 * authoritative number is `seller_receivable_breakdown.paypal_fee`.
 */

import { config } from './config.js';

export type FeeSchedule = { rate: number; fixedMinor: number };

/** A currency without a configured schedule quotes no fee at all. */
const NO_FEE: FeeSchedule = { rate: 0, fixedMinor: 0 };

export function feeScheduleFor(currency: string): FeeSchedule {
  const code = currency.trim().toUpperCase();
  return config.paypalFeeSchedules[code] ?? NO_FEE;
}

/** Smallest gross that still leaves `netMinor` after the fee is taken. */
export function grossUpMinor(netMinor: number, schedule: FeeSchedule): number {
  if (netMinor <= 0) return 0;
  if (schedule.rate <= 0 && schedule.fixedMinor <= 0) return netMinor;
  // `ceil` so the fronter never ends up a minor unit short.
  return Math.ceil((netMinor + schedule.fixedMinor) / (1 - schedule.rate));
}

export function feeMinor(netMinor: number, schedule: FeeSchedule): number {
  return grossUpMinor(netMinor, schedule) - netMinor;
}

/**
 * Charging the payer PayPal's own fee is a surcharge, prohibited by the US
 * (§4.5) and Thai *No Surcharges* clauses in the user agreement. The feature
 * is therefore sandbox-only until someone with authority confirms the
 * market-specific wording in writing and sets PAYPAL_FEE_COVER_LIVE_ALLOWED.
 */
export function feeCoverAllowed(): boolean {
  return config.paypalEnv !== 'live' || config.paypalFeeCoverLiveAllowed;
}
