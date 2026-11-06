const KEY = 'globie.displayCurrency';

/**
 * Web half of the display-currency preference (§2.19). Same contract as the
 * native store; private browsing simply keeps the choice in memory.
 */
export async function getDisplayCurrency(): Promise<string | null> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw && /^[A-Z]{3}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function setDisplayCurrency(code: string | null): Promise<void> {
  try {
    if (code) globalThis.localStorage?.setItem(KEY, code);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // ignore
  }
}
