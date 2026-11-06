import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * The Activity tab is the notification centre for anyone the Expo Push Service
 * cannot reach (the web build, §2.13). "Seen" is therefore just a watermark on
 * this device: everything newer than it earns the dot on the tab.
 */

const KEY = 'globie.activity.seen';

let seenAt: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Read once at import: a badge is not worth blocking the first render on.
SecureStore.getItemAsync(KEY)
  .then((stored) => {
    seenAt = stored;
    emit();
  })
  .catch(() => undefined);

export function useActivitySeenAt(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => seenAt,
    () => null
  );
}

export async function markActivitySeen(at: string): Promise<void> {
  if (seenAt === at) return;
  seenAt = at;
  emit();
  try {
    await SecureStore.setItemAsync(KEY, at);
  } catch {
    // Losing the watermark only costs one extra dot.
  }
}
