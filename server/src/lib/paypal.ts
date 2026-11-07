/**
 * Minimal PayPal Orders v2 client. Members approve in the system browser, we
 * capture server-side and reconcile through webhooks (DEV_PLAN §2.9).
 */

import { config } from './config.js';
import { ApiError } from './http-error.js';

type PayPalLink = { href: string; rel: string; method?: string };

type OrderResponse = {
  id: string;
  status: string;
  links?: PayPalLink[];
  /** ISO timestamp of when PayPal opened the checkout. */
  create_time?: string;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * PayPal works in major units; every Globie amount is integer minor units.
 * ISO-4217 minor-unit exponents — anything absent from both sets uses 2.
 */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function isPayPalConfigured(): boolean {
  return Boolean(config.paypalClientId && config.paypalClientSecret);
}

function apiBase(): string {
  return config.paypalEnv === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

export function formatAmount(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  return (amountMinor / 10 ** exponent).toFixed(exponent);
}

/** Inverse of `formatAmount` for amounts arriving in a webhook payload. */
export function toMinorAmount(value: unknown, currency: string): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 10 ** currencyExponent(currency));
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const basic = Buffer.from(
    `${config.paypalClientId}:${config.paypalClientSecret}`,
  ).toString('base64');

  const response = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new ApiError(
      502,
      'paypal_auth_failed',
      'PayPal rejected the API credentials',
    );
  }

  const payload = (await response.json()) as TokenResponse;
  if (!payload.access_token) {
    throw new ApiError(502, 'paypal_auth_failed', 'PayPal returned no access token');
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3000) * 1000,
  };
  return cachedToken.value;
}

/** What the money is for: a reimbursement share or a tip for the fronter. */
export type OrderTarget = { kind: 'share' | 'tip'; id: string };

/**
 * Who receives the money. The fronter already paid the merchant outside PayPal,
 * so reimbursements settle straight into their account; Globie never holds it.
 *
 * `merchantId` wins when set: a PayPal Business account can be addressed by its
 * merchant id, while an email only works for an account that accepts payments.
 */
export type Payee = { email: string | null; merchantId?: string | null };

/**
 * One order per target. The target id doubles as the idempotency key so a retry
 * returns the order that was already created instead of double-charging.
 *
 * `payee` is mandatory: an order without it would collect into the platform
 * account, which is the money-transmission model we deliberately avoid.
 */
export async function createOrder(input: {
  target: OrderTarget;
  amountMinor: number;
  currency: string;
  description: string;
  payee: Payee;
  /**
   * Overrides the deterministic idempotency key. PayPal replays the original
   * response for a reused key — including an order the payer already refused —
   * so a retry has to send a new one.
   */
  requestId?: string;
}): Promise<{ id: string; approveUrl: string }> {
  const token = await accessToken();

  // A merchant id addresses the account itself, which is what a Business
  // account needs for a cross-border reimbursement; email is the fallback.
  const payee = input.payee.merchantId
    ? { merchant_id: input.payee.merchantId }
    : input.payee.email
      ? { email_address: input.payee.email }
      : null;

  if (!payee) {
    throw new ApiError(
      502,
      'paypal_order_failed',
      'A payee email or merchant id is required',
    );
  }

  const response = await fetch(`${apiBase()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id':
        input.requestId ?? `globie-${input.target.kind}-${input.target.id}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: input.target.id,
          custom_id: input.target.id,
          description: input.description.slice(0, 127),
          // A split bill is a transfer of money, not a parcel. Without this
          // PayPal defaults to PHYSICAL_GOODS and the hosted checkout makes the
          // payer fill in a delivery/billing address even with NO_SHIPPING.
          category: 'DIGITAL_GOODS',
          amount: {
            currency_code: input.currency,
            value: formatAmount(input.amountMinor, input.currency),
          },
          // Created with our credentials, settled to the payee: the capture moves
          // money from the payer straight to the fronter.
          payee,
        },
      ],
      // `application_context` is the legacy slot; with a `payment_source` present
      // PayPal ignores it, so the checkout hints live under experience_context.
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Globie Keeper',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl(config.paypalReturnUrl, input.target),
            cancel_url: config.paypalCancelUrl,
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new ApiError(
      502,
      'paypal_order_failed',
      `PayPal could not create the order (${response.status})`,
    );
  }

  const order = (await response.json()) as OrderResponse;
  const approveUrl = order.links?.find(
    (link) => link.rel === 'approve' || link.rel === 'payer-action',
  )?.href;

  if (!order.id || !approveUrl) {
    throw new ApiError(502, 'paypal_order_failed', 'PayPal returned no approval link');
  }

  return { id: order.id, approveUrl };
}

/**
 * PayPal appends `token` and `PayerID` to the return URL, so the target id has
 * to travel there too: the client resumes the capture from that page. The key
 * matches the `?share=` / `?tip=` branch in the app's PayPal return screen.
 */
function returnUrl(base: string, target: OrderTarget): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${target.kind}=${encodeURIComponent(target.id)}`;
}

type CaptureResource = {
  id: string;
  status?: string;
  amount?: { currency_code?: string; value?: string };
  supplementary_data?: { related_ids?: { order_id?: string } };
};

type CaptureResponse = OrderResponse & {
  purchase_units?: Array<{ payments?: { captures?: CaptureResource[] } }>;
  details?: Array<{ issue?: string; description?: string }>;
};

export type CaptureResult = {
  /** `null` when PayPal reported the order complete without a capture object. */
  captureId: string | null;
  status: string;
  /** Full PayPal response, stored on `payments.raw_payload`. */
  raw: unknown;
};

function firstCapture(order: CaptureResponse): CaptureResult | null {
  const capture = order.purchase_units
    ?.flatMap((unit) => unit.payments?.captures ?? [])
    .find((row) => Boolean(row.id));

  if (!capture) return null;
  return { captureId: capture.id, status: capture.status ?? 'COMPLETED', raw: order };
}

async function getOrder(orderId: string): Promise<CaptureResponse> {
  const token = await accessToken();
  const response = await fetch(
    `${apiBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new ApiError(
      502,
      'paypal_order_failed',
      `PayPal could not read the order (${response.status})`,
    );
  }

  return (await response.json()) as CaptureResponse;
}

/**
 * Read an order without touching it. The checkout status is the only way to
 * tell an approval we never captured (`APPROVED`) from a checkout PayPal
 * refused at its own page (`CREATED` forever, no webhook, no return URL).
 */
export async function readOrder(
  orderId: string,
): Promise<{ status: string; captureId: string | null; createTime: string | null }> {
  const order = await getOrder(orderId);
  return {
    status: order.status,
    captureId: firstCapture(order)?.captureId ?? null,
    createTime: order.create_time ?? null,
  };
}

/**
 * Capture an approved order. Retrying is safe: PayPal answers 422
 * `ORDER_ALREADY_CAPTURED`, and we then read the capture that already exists.
 */
export async function captureOrder(orderId: string): Promise<CaptureResult> {
  const token = await accessToken();

  const response = await fetch(
    `${apiBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `globie-capture-${orderId}`,
      },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    },
  );

  const payload = (await response.json().catch(() => null)) as CaptureResponse | null;

  if (!response.ok) {
    const issue = payload?.details?.[0]?.issue;
    if (issue === 'ORDER_ALREADY_CAPTURED') {
      const existing = firstCapture(await getOrder(orderId));
      if (existing) return existing;
    }
    throw new ApiError(
      502,
      'paypal_capture_failed',
      `PayPal could not capture the order (${response.status}${issue ? ` ${issue}` : ''})`,
    );
  }

  const result = payload ? firstCapture(payload) : null;
  if (!result) {
    throw new ApiError(502, 'paypal_capture_failed', 'PayPal returned no capture');
  }
  return result;
}

export type WebhookHeaders = {
  transmissionId?: string;
  transmissionTime?: string;
  transmissionSig?: string;
  certUrl?: string;
  authAlgo?: string;
};

/**
 * PayPal confirms the signature by re-hashing the event with its certificate,
 * so the parsed body is enough; the raw bytes are kept for the audit table.
 */
export async function verifyWebhookSignature(input: {
  headers: WebhookHeaders;
  event: unknown;
}): Promise<boolean> {
  const { headers } = input;
  if (
    !headers.transmissionId ||
    !headers.transmissionTime ||
    !headers.transmissionSig ||
    !headers.certUrl ||
    !headers.authAlgo
  ) {
    return false;
  }

  const token = await accessToken();
  const response = await fetch(`${apiBase()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: config.paypalWebhookId,
      webhook_event: input.event,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new ApiError(
      502,
      'paypal_webhook_verify_failed',
      `PayPal could not verify the webhook (${response.status})`,
    );
  }

  const payload = (await response.json()) as { verification_status?: string };
  return payload.verification_status === 'SUCCESS';
}

// --- "Log in with PayPal" — Identity API (DEV_PLAN §2.17) --------------------
// Same client id and secret as the money calls above, but a different grant:
// the member approves a code in the browser and we exchange it server-side, so
// the secret never reaches the app.

export type LoginTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
};

export function buildLoginAuthorizeUrl(state: string): string {
  const host =
    config.paypalEnv === 'live'
      ? 'https://www.paypal.com'
      : 'https://www.sandbox.paypal.com';

  const query = new URLSearchParams({
    flowEntry: 'static',
    client_id: config.paypalClientId,
    response_type: 'code',
    // Must match the user-info fields ticked in the PayPal dashboard.
    scope: config.paypalLoginScopes,
    redirect_uri: config.paypalLoginReturnUrl,
    state,
    // The native auth sheet is a full browser page; the popup layout squashes it.
    fullPage: 'true',
  });

  return `${host}/connect?${query.toString()}`;
}

export async function exchangeAuthorizationCode(code: string): Promise<LoginTokens> {
  const basic = Buffer.from(
    `${config.paypalClientId}:${config.paypalClientSecret}`,
  ).toString('base64');

  const response = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => null)) as
    | (TokenResponse & { refresh_token?: string; scope?: string })
    | null;

  if (!response.ok || !payload?.access_token) {
    throw new ApiError(
      502,
      'paypal_login_failed',
      'PayPal rejected the authorization code',
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 28_800,
    scope: payload.scope ?? '',
  };
}

type UserInfoResponse = {
  user_id?: string;
  payer_id?: string;
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  email_verified?: boolean | string;
};

export type PayPalIdentity = {
  payerId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
};

/**
 * The fields returned depend on the scopes granted, so every key is optional
 * and the identity is derived defensively. An identity without a payer id or an
 * email cannot become an account.
 */
export async function fetchUserInfo(accessToken: string): Promise<PayPalIdentity> {
  const response = await fetch(`${apiBase()}/v1/identity/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new ApiError(
      502,
      'paypal_login_failed',
      `PayPal could not read the account (${response.status})`,
    );
  }

  const payload = (await response.json()) as UserInfoResponse;
  const payerId = payload.payer_id ?? payload.user_id ?? payload.sub ?? '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';

  if (!payerId || !email) {
    throw new ApiError(
      502,
      'paypal_login_failed',
      'PayPal returned no payer id or email address',
    );
  }

  const name = (
    payload.name ??
    [payload.given_name, payload.family_name].filter(Boolean).join(' ')
  ).trim();

  return {
    payerId,
    email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    displayName: name || email.split('@')[0] || 'Globie member',
  };
}
