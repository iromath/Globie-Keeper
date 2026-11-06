import { useQueryClient } from '@tanstack/react-query';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

import { request } from './api';
import { convertMinor, deviceCurrency } from './fx';
import { getDisplayCurrency, setDisplayCurrency as storeDisplayCurrency } from './fx-store';
import { formatMinor } from './money';
import { queryKeys, useFxRates, useMyProfile } from './queries';
import { useSession } from './session-context';

type MoneyState = {
  /**
   * The currency amounts should be read in, or null when the canonical group
   * currency should be shown as-is.
   */
  displayCurrency: string | null;
  /** True while the device and account preferences are still being read. */
  ready: boolean;
  /** Currency codes the rate table knows about, sorted. */
  currencies: string[];
  /** The currency every rate is quoted against. */
  ratesBase: string | null;
  /** Units of each quote per 1 `ratesBase`, for the picker's rate hints. */
  rates: Record<string, number> | null;
  ratesAsOf: string | null;
  /** The upstream fetch failed; these are the last known good rates. */
  ratesStale: boolean;
  /** Writes the choice to the device and, when signed in, to the account. */
  setDisplayCurrency: (code: string | null) => Promise<void>;
  /** Converted and marked `≈` when a display currency applies, else canonical. */
  format: (amountMinor: number, currency: string) => string;
  /** Always the canonical group currency — use it wherever money is charged. */
  formatOriginal: (amountMinor: number, currency: string) => string;
  /** The `≈ €34.56` form, or null when no conversion applies. */
  approximate: (amountMinor: number, currency: string) => string | null;
};

const MoneyContext = createContext<MoneyState | null>(null);

/**
 * Display-currency state (DEV_PLAN §2.19). FX never enters the money path: this
 * provider only decides how an amount is rendered, and falls back to the
 * canonical value whenever a rate is missing.
 */
export function MoneyProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const client = useQueryClient();

  const [device] = useState<string | null>(() => deviceCurrency());
  const [stored, setStored] = useState<string | null>(null);
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDisplayCurrency()
      .then((value) => {
        if (!cancelled) setStored(value);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const profile = useMyProfile(Boolean(session));
  const fx = useFxRates();

  const account = override !== undefined ? override : (profile.data?.displayCurrency ?? null);
  const displayCurrency = account ?? stored ?? device;

  const setDisplayCurrency = useCallback(
    async (code: string | null) => {
      const next = code ? code.trim().toUpperCase() : null;
      setOverride(next);
      setStored(next);
      await storeDisplayCurrency(next);

      if (!session) return;
      await request('/me', { method: 'PATCH', body: { displayCurrency: next } });
      await client.invalidateQueries({ queryKey: queryKeys.myProfile });
    },
    [session, client]
  );

  const rates = fx.data?.rates ?? null;

  const formatOriginal = useCallback(
    (amountMinor: number, currency: string) => formatMinor(amountMinor, currency),
    []
  );

  const approximate = useCallback(
    (amountMinor: number, currency: string): string | null => {
      if (!displayCurrency || displayCurrency === currency.trim().toUpperCase()) return null;
      const converted = convertMinor(amountMinor, currency, displayCurrency, rates);
      return converted === null ? null : `≈ ${formatMinor(converted, displayCurrency)}`;
    },
    [displayCurrency, rates]
  );

  const format = useCallback(
    (amountMinor: number, currency: string) =>
      approximate(amountMinor, currency) ?? formatOriginal(amountMinor, currency),
    [approximate, formatOriginal]
  );

  const currencies = useMemo(() => Object.keys(rates ?? {}).sort(), [rates]);

  const value = useMemo(
    () => ({
      displayCurrency,
      ready,
      currencies,
      ratesBase: fx.data?.base ?? null,
      rates,
      ratesAsOf: fx.data?.asOf ?? null,
      ratesStale: fx.data?.stale ?? false,
      setDisplayCurrency,
      format,
      formatOriginal,
      approximate,
    }),
    [
      displayCurrency,
      ready,
      currencies,
      fx.data?.base,
      rates,
      fx.data?.asOf,
      fx.data?.stale,
      setDisplayCurrency,
      format,
      formatOriginal,
      approximate,
    ]
  );

  return <MoneyContext.Provider value={value}>{children}</MoneyContext.Provider>;
}

export function useMoney(): MoneyState {
  const context = useContext(MoneyContext);
  if (!context) throw new Error('useMoney must be used inside MoneyProvider');
  return context;
}
