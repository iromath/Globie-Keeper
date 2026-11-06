const KEY = 'globie.session';

export type StoredSession = { token: string; userId: string; displayName: string };

export async function getSession(): Promise<StoredSession | null> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export async function setSession(session: StoredSession): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(session));
  } catch {
    // private browsing: session stays in memory for this page load
  }
}

export async function clearSession(): Promise<void> {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // ignore
  }
}
