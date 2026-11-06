import * as SecureStore from 'expo-secure-store';

const KEY = 'globie.displayCurrency';

/**
 * The device half of the display-currency preference (§2.19). It is read before
 * the profile call resolves, so a reload does not flash the group currency.
 */
export async function getDisplayCurrency(): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw && /^[A-Z]{3}$/.test(raw) ? raw : null;
}

export async function setDisplayCurrency(code: string | null): Promise<void> {
  if (code) await SecureStore.setItemAsync(KEY, code);
  else await SecureStore.deleteItemAsync(KEY);
}
