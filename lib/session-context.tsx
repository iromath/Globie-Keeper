import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

import { completePayPalHandoff, signIn as signInRequest } from './api';
import { startPayPalLogin, type PayPalLoginOutcome } from './paypal-login';
import { registerForPush, unregisterPush } from './push';
import { clearSession, getSession, type StoredSession } from './session';

type SessionState = {
  session: StoredSession | null;
  ready: boolean;
  signIn: (email: string, displayName: string) => Promise<void>;
  /** Opens PayPal's consent page; native resolves with the outcome in place. */
  signInWithPayPal: () => Promise<PayPalLoginOutcome>;
  /** Web return page: trade the one-time code from the redirect. */
  completePayPalLogin: (code: string) => Promise<StoredSession>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((stored) => {
        if (cancelled) return;
        setSessionState(stored);
        // Expo tokens can rotate between launches; re-registering is idempotent.
        if (stored) void registerForPush();
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, displayName: string) => {
    const next = await signInRequest(email, displayName);
    setSessionState(next);
    // Fire-and-forget: a declined prompt or a missing EAS project must never
    // hold up the member getting into the app.
    void registerForPush();
  }, []);

  const signInWithPayPal = useCallback(async () => {
    const outcome = await startPayPalLogin();
    if (outcome.status === 'signed-in') {
      setSessionState(outcome.session);
      void registerForPush();
    }
    return outcome;
  }, []);

  const completePayPalLogin = useCallback(async (code: string) => {
    const next = await completePayPalHandoff(code);
    setSessionState(next);
    void registerForPush();
    return next;
  }, []);

  const signOut = useCallback(async () => {
    // The token has to be dropped while the session is still valid.
    await unregisterPush();
    await clearSession();
    setSessionState(null);
  }, []);

  const value = useMemo(
    () => ({ session, ready, signIn, signInWithPayPal, completePayPalLogin, signOut }),
    [session, ready, signIn, signInWithPayPal, completePayPalLogin, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
