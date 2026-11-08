import { API_BASE } from './config';
import { getSession, setSession, type StoredSession } from './session';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = await getSession();
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body:
        options.formData ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
      signal: options.signal,
    });
  } catch {
    // A dropped connection, a proxy timeout or an error page without CORS
    // headers all reach us as the browser's own "Failed to fetch". Say
    // something the member can act on instead of echoing that.
    throw new ApiError(
      0,
      'network_error',
      'Could not reach Globie Keeper — check your connection and try again.'
    );
  }

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const code = (payload as { code?: string } | null)?.code ?? 'request_failed';
    const message =
      (payload as { message?: string } | null)?.message ??
      `Request failed (${response.status})`;
    throw new ApiError(response.status, code, message);
  }

  return payload as T;
}

type SessionPayload = { token: string; userId: string; displayName: string };

/** One place that turns a session response into the stored record. */
async function storeSession(payload: SessionPayload): Promise<StoredSession> {
  const session: StoredSession = {
    token: payload.token,
    userId: payload.userId,
    displayName: payload.displayName,
  };
  await setSession(session);
  return session;
}

/**
 * Exchange an email + password for a session token. Passing `displayName`
 * turns the call into a sign-up; without it an unknown address is rejected,
 * so the API never creates an account nobody asked for.
 */
export async function signIn(
  email: string,
  password: string,
  displayName?: string
): Promise<StoredSession> {
  return storeSession(
    await request<SessionPayload>('/auth/session', {
      body: displayName ? { email, password, displayName } : { email, password },
    })
  );
}

/** Drop the token on the server too; the local copy is cleared by the caller. */
export async function signOutRequest(): Promise<void> {
  try {
    await request<void>('/auth/logout', { method: 'POST' });
  } catch {
    // Signing out must work offline — the local token is discarded regardless.
  }
}

/**
 * Absolute URL that hands the browser to PayPal's consent page (DEV_PLAN
 * §2.17). The API owns the client secret, the state and the token exchange, so
 * the client only ever navigates to this address.
 */
export function payPalLoginUrl(surface: 'web' | 'native'): string {
  return `${API_BASE}/auth/paypal/start?surface=${surface}`;
}

/** Trade the 60-second redirect code for the real session token. */
export async function completePayPalHandoff(code: string): Promise<StoredSession> {
  return storeSession(
    await request<SessionPayload>('/auth/paypal/handoff', { body: { code } })
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
