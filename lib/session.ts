import * as SecureStore from 'expo-secure-store';

const KEY = 'globie.session';

export type StoredSession = { token: string; userId: string; displayName: string };

export async function getSession(): Promise<StoredSession | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

export async function setSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
