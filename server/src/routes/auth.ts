import type { FastifyInstance } from 'fastify';

import { isUniqueViolation, query, withTransaction } from '../db/pool.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { createOpaqueCode, createSessionToken, hashToken } from '../lib/ids.js';
import {
    hashPassword,
    isAcceptablePassword,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    verifyPassword,
} from '../lib/password.js';
import {
    buildLoginAuthorizeUrl,
    exchangeAuthorizationCode,
    fetchUserInfo,
    isPayPalConfigured,
    type PayPalIdentity,
} from '../lib/paypal.js';
import { consume, forget } from '../lib/throttle.js';
import { asRecord, optionalString, requiredString } from '../lib/validate.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  paypal_payer_id: string | null;
};

type SessionResponse = { token: string; userId: string; displayName: string };

/** One message for "no such email" and "wrong password" — never confirm which. */
function invalidCredentials(): ApiError {
  return new ApiError(
    401,
    'invalid_credentials',
    'That email and password do not match.',
  );
}

/**
 * Read the password without trimming it: spaces are part of the secret, so
 * `requiredString` (which trims) is the wrong tool here.
 */
function readPassword(body: Record<string, unknown>): string {
  const value = body.password;
  if (typeof value !== 'string' || !isAcceptablePassword(value)) {
    throw ApiError.badRequest(
      'invalid_password',
      `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return value;
}

/** Bearer token + 60-day row, identical for email and PayPal sign-in. */
async function issueSession(userId: string): Promise<string> {
  const token = createSessionToken();
  await query(
    `insert into sessions (token_hash, user_id, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)`,
    [hashToken(token), userId, String(config.sessionTtlDays)],
  );
  // Rows are only read while unexpired; retiring them keeps the table bounded.
  await query(`delete from sessions where expires_at < now()`);
  return token;
}

/** Append query parameters to an http(s) or custom-scheme URL. */
function withQuery(base: string, params: Record<string, string>): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${new URLSearchParams(params).toString()}`;
}

function loginReturnTarget(returnTo: string): string {
  return returnTo === 'native'
    ? config.paypalLoginNativeReturnUrl
    : config.paypalLoginWebReturnUrl;
}

/**
 * Link the verified PayPal identity to a Globie account (DEV_PLAN §2.17).
 *
 * One statement finishes the merge: a new email inserts, an existing email is
 * linked in place, and a row already carrying a different payer id fails the
 * `where` and returns nothing — which becomes `409 paypal_already_linked`.
 * That keeps two simultaneous logins from duplicating or stealing the row.
 */
async function linkPayPalAccount(
  identity: PayPalIdentity,
): Promise<{ userId: string; displayName: string }> {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; display_name: string }>(
        `insert into users
           (email, display_name, paypal_payer_id, paypal_email, paypal_verified, paypal_linked_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (lower(email)) do update
            set paypal_payer_id = excluded.paypal_payer_id,
                paypal_email = excluded.paypal_email,
                paypal_verified = excluded.paypal_verified,
                paypal_linked_at = now()
          where users.paypal_payer_id is null
             or users.paypal_payer_id = excluded.paypal_payer_id
         returning id, display_name`,
        [
          identity.email,
          identity.displayName,
          identity.payerId,
          identity.email,
          identity.emailVerified,
        ],
      );

      const user = rows[0];
      if (!user) {
        throw ApiError.conflict(
          'paypal_already_linked',
          'This email is already linked to a different PayPal account',
        );
      }

      // Reimbursements settle into members.paypal_email (§2.9); link once, ask never.
      await client.query(
        `update members
            set paypal_email = $2
          where user_id = $1 and paypal_email is null`,
        [user.id, identity.email],
      );

      return { userId: user.id, displayName: user.display_name };
    });
  } catch (error) {
    // The partial unique index on paypal_payer_id: one PayPal, one account.
    if (isUniqueViolation(error)) {
      throw ApiError.conflict(
        'paypal_already_linked',
        'This PayPal account is already linked to another member',
      );
    }
    throw error;
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Email + password sign-in (DEV_PLAN §2.17).
   *
   * The address alone no longer mints a session: an existing row has to
   * present the password it was created with. A row created before passwords
   * existed (no hash, no PayPal link) claims one on its first sign-in and
   * never accepts an email-only request again.
   *
   * A create-account request is the same call carrying `displayName`. Without
   * it, an unknown address is just a failed sign-in, so the endpoint cannot be
   * turned into an account factory by guessing addresses.
   */
  app.post('/auth/session', async (request): Promise<SessionResponse> => {
    const body = asRecord(request.body);
    const email = requiredString(body, 'email', { min: 3, max: 320 }).toLowerCase();
    const password = readPassword(body);
    const displayName = optionalString(body, 'displayName', 80);

    if (!EMAIL.test(email)) {
      throw ApiError.badRequest('invalid_email', 'email is not a valid address');
    }

    // Per-IP first: credential stuffing rotates emails, so the address bucket
    // alone would never trip. Five times the per-email ceiling leaves room for
    // a shared office NAT.
    const window = config.authAttemptWindowMs;
    const throttleMessage = 'Too many sign-in attempts. Wait a few minutes and try again.';
    if (!consume(`auth:ip:${request.ip}`, config.authAttemptLimit * 5, window)) {
      throw ApiError.tooManyRequests(throttleMessage);
    }
    const emailKey = `auth:email:${email}`;
    if (!consume(emailKey, config.authAttemptLimit, window)) {
      throw ApiError.tooManyRequests(throttleMessage);
    }

    const { rows } = await query<UserRow>(
      `select id, email, display_name, password_hash, paypal_payer_id
         from users
        where lower(email) = $1`,
      [email],
    );
    const user = rows[0];

    if (user) {
      if (user.password_hash) {
        if (!(await verifyPassword(password, user.password_hash))) {
          throw invalidCredentials();
        }
        forget(emailKey);
        return {
          token: await issueSession(user.id),
          userId: user.id,
          displayName: user.display_name,
        };
      }

      // No password means no email credential. PayPal-linked rows sign in with
      // PayPal; every other such row was retired by 016 and its address freed.
      if (user.paypal_payer_id) {
        throw ApiError.conflict(
          'use_paypal_login',
          'This account signs in with PayPal',
        );
      }

      throw invalidCredentials();
    }

    if (!displayName) throw invalidCredentials();

    const { rows: created } = await query<{ id: string; display_name: string }>(
      `insert into users (email, display_name, password_hash, password_updated_at)
       values ($1, $2, $3, now())
       on conflict (lower(email)) do nothing
       returning id, display_name`,
      [email, displayName, await hashPassword(password)],
    );
    const fresh = created[0];
    // Lost a race with a simultaneous sign-up: the next attempt signs in.
    if (!fresh) throw invalidCredentials();

    forget(emailKey);
    return {
      token: await issueSession(fresh.id),
      userId: fresh.id,
      displayName: fresh.display_name,
    };
  });

  /**
   * Revoke the bearer token server-side. Without this a token stayed valid for
   * its full 60 days after the client forgot it.
   */
  app.post('/auth/logout', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : '';
    if (token) {
      await query(`delete from sessions where token_hash = $1`, [hashToken(token)]);
    }
    return reply.code(204).send();
  });

  /**
   * Step 1 of "Log in with PayPal": mint a single-use state, remember which
   * surface asked, and bounce the browser to PayPal's consent page.
   */
  app.get('/auth/paypal/start', async (request, reply) => {
    const params = (request.query ?? {}) as Record<string, unknown>;
    const returnTo = params.surface === 'native' ? 'native' : 'web';

    // A browser opened this URL, so answer like the callback does: redirect with
    // `error=` instead of showing the JSON error contract.
    if (!isPayPalConfigured()) {
      return reply.redirect(
        withQuery(loginReturnTarget(returnTo), { error: 'paypal_not_configured' }),
      );
    }

    // Keep both short-lived tables bounded without a scheduled job.
    await query(
      `delete from paypal_login_states where created_at < now() - interval '10 minutes'`,
    );
    await query(
      `delete from auth_handoffs where expires_at < now() - interval '1 hour'`,
    );

    const state = createOpaqueCode();
    await query(
      `insert into paypal_login_states (state_hash, return_to) values ($1, $2)`,
      [hashToken(state), returnTo],
    );

    return reply.redirect(buildLoginAuthorizeUrl(state));
  });

  /**
   * Step 2: PayPal sends the browser back here with a code. Everything that
   * can go wrong is answered with a redirect carrying `error=`, so a browser
   * never sees the JSON error contract.
   */
  app.get('/auth/paypal/callback', async (request, reply) => {
    const params = (request.query ?? {}) as Record<string, unknown>;
    const state = typeof params.state === 'string' ? params.state : '';
    const code = typeof params.code === 'string' ? params.code : '';
    const oauthError = typeof params.error === 'string' ? params.error : '';
    const webFallback = config.paypalLoginWebReturnUrl;

    if (!state) {
      return reply.redirect(withQuery(webFallback, { error: 'invalid_state' }));
    }

    // Consuming the row is the replay check: only the first return of a state
    // hashes to something rows are deleted for.
    const consumed = await query<{ return_to: string }>(
      `delete from paypal_login_states
        where state_hash = $1
          and created_at > now() - interval '10 minutes'
        returning return_to`,
      [hashToken(state)],
    );

    const stored = consumed.rows[0];
    if (!stored) {
      return reply.redirect(withQuery(webFallback, { error: 'invalid_state' }));
    }

    const target = loginReturnTarget(stored.return_to);

    if (oauthError || !code) {
      return reply.redirect(withQuery(target, { error: 'cancelled' }));
    }

    try {
      const tokens = await exchangeAuthorizationCode(code);
      // Access and refresh tokens are intentionally dropped after this call.
      const identity = await fetchUserInfo(tokens.accessToken);
      const account = await linkPayPalAccount(identity);

      // The browser only ever carries a 60-second code, never a session token.
      const handoff = createOpaqueCode();
      await query(
        `insert into auth_handoffs (code_hash, user_id, expires_at)
         values ($1, $2, now() + interval '60 seconds')`,
        [hashToken(handoff), account.userId],
      );

      return reply.redirect(withQuery(target, { handoff }));
    } catch (error) {
      request.log.warn({ err: error }, 'paypal login failed');

      const failure =
        error instanceof ApiError && error.code === 'paypal_already_linked'
          ? 'paypal_already_linked'
          : 'paypal_login_failed';

      return reply.redirect(withQuery(target, { error: failure }));
    }
  });

  /** Step 3: trade the one-time code for the session token. */
  app.post('/auth/paypal/handoff', async (request): Promise<SessionResponse> => {
    const body = asRecord(request.body);
    const code = requiredString(body, 'code', { min: 20, max: 200 });

    const { rows } = await query<{ user_id: string; display_name: string }>(
      `with used as (
         update auth_handoffs
            set used_at = now()
          where code_hash = $1
            and used_at is null
            and expires_at > now()
        returning user_id
       )
       select used.user_id, users.display_name
         from used
         join users on users.id = used.user_id`,
      [hashToken(code)],
    );

    const handoff = rows[0];
    if (!handoff) {
      throw new ApiError(
        401,
        'invalid_handoff',
        'That sign-in link has expired. Try again.',
      );
    }

    return {
      token: await issueSession(handoff.user_id),
      userId: handoff.user_id,
      displayName: handoff.display_name,
    };
  });
}
