import * as WebBrowser from 'expo-web-browser';

import { completePayPalHandoff, payPalLoginUrl } from './api';
import { IS_WEB } from './config';
import type { StoredSession } from './session';

/**
 * "Log in with PayPal" from the client side (DEV_PLAN §2.17). The API owns the
 * state, the secret and the token exchange; this module only opens the consent
 * page and trades the one-time redirect code for a session.
 */

/** Must match PAYPAL_LOGIN_NATIVE_RETURN_URL on the server, i.e. app.json `scheme`. */
const NATIVE_RETURN_URL = 'globiekeeper://auth/return';

export type PayPalLoginOutcome =
  | { status: 'signed-in'; session: StoredSession }
  | { status: 'redirecting' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** The callback answers with a code, never a session token. */
const MESSAGES: Record<string, string> = {
  cancelled: 'PayPal sign-in was cancelled.',
  invalid_state: 'That sign-in link expired. Please try again.',
  paypal_already_linked:
    'This PayPal account is already linked to a different Globie account.',
  paypal_login_failed: 'PayPal could not confirm that account. Please try again.',
  paypal_not_configured: 'PayPal sign-in is not switched on for this server yet.',
};

export function payPalErrorMessage(code: string | null): string {
  return (
    (code ? MESSAGES[code] : null) ?? 'PayPal sign-in did not complete. Please try again.'
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Read `handoff` / `error` out of either an https return URL or our deep link. */
export function readPayPalReturn(url: string): {
  handoff: string | null;
  error: string | null;
} {
  const query = url.split('?')[1] ?? '';
  const values = new Map<string, string>();

  for (const pair of query.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? '' : pair.slice(index + 1);
    values.set(safeDecode(key), safeDecode(value));
  }

  return { handoff: values.get('handoff') ?? null, error: values.get('error') ?? null };
}

/**
 * Web navigates the page (a sheet is the wrong affordance in a browser); native
 * opens the auth sheet and reads the deep link it comes back with. Anything but
 * an explicit `success` is a cancel, so dismissing the sheet is silent.
 */
export async function startPayPalLogin(): Promise<PayPalLoginOutcome> {
  if (IS_WEB) {
    window.location.assign(payPalLoginUrl('web'));
    return { status: 'redirecting' };
  }

  try {
    const result = await WebBrowser.openAuthSessionAsync(
      payPalLoginUrl('native'),
      NATIVE_RETURN_URL
    );
    if (result.type !== 'success') return { status: 'cancelled' };

    const { handoff, error } = readPayPalReturn(result.url);
    if (error) return { status: 'error', message: payPalErrorMessage(error) };
    if (!handoff) return { status: 'error', message: payPalErrorMessage(null) };

    return { status: 'signed-in', session: await completePayPalHandoff(handoff) };
  } catch (cause) {
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : payPalErrorMessage(null),
    };
  }
}
