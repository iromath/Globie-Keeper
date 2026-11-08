import { ApiError } from './http-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** "Merchant account ID" from the PayPal dashboard: alphanumeric, 13 in practice. */
const MERCHANT_ID = /^[A-Za-z0-9]{6,32}$/;
/** The slug after `paypal.me/`: letters, digits, dot, dash or underscore. */
const PAYPAL_ME_HANDLE = /^[A-Za-z0-9._-]{3,40}$/;

/** How a fronter gets reimbursed. Chosen per member, snapshotted per share. */
export type PaymentMode = 'payee_direct' | 'paypal_me';

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('invalid_body', 'Expected a JSON object body');
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  source: Record<string, unknown>,
  key: string,
  { min = 1, max = 200 }: { min?: number; max?: number } = {},
): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be ${min}-${max} characters`,
    );
  }
  return trimmed;
}

export function optionalString(
  source: Record<string, unknown>,
  key: string,
  max = 200,
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a string`);
  }
  return value.trim().slice(0, max);
}

export function requiredUuid(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a UUID`);
  }
  return value;
}

export function pathUuid(value: unknown, key = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a UUID`);
  }
  return value;
}

export function requiredMinor(
  source: Record<string, unknown>,
  key: string,
): number {
  const value = source[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be a non-negative integer in minor units`,
    );
  }
  return value;
}

export function currencyCode(value: unknown, key = 'currency'): string {
  if (typeof value !== 'string' || !CURRENCY.test(value.toUpperCase())) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be an ISO-4217 code`);
  }
  return value.toUpperCase();
}

/**
 * PayPal addresses where the money should land. Normalised to lower case so the
 * same person does not end up with two spellings across memberships.
 */
export function optionalEmail(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 254 || !EMAIL.test(value.trim())) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be an email address`);
  }
  return value.trim().toLowerCase();
}

/**
 * PayPal addresses the account by merchant id when it has one, which is what a
 * Business account needs to take a cross-border reimbursement. Stored verbatim:
 * unlike an email, the id is case-sensitive.
 */
export function optionalMerchantId(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !MERCHANT_ID.test(value.trim())) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be a PayPal merchant id`,
    );
  }
  return value.trim();
}

export function paymentMode(
  source: Record<string, unknown>,
  key: string,
): PaymentMode {
  const value = source[key];
  if (value === 'payee_direct' || value === 'paypal_me') return value;
  throw ApiError.badRequest(
    `invalid_${key}`,
    `${key} must be payee_direct or paypal_me`,
  );
}

/**
 * The PayPal.Me slug, stored without the leading "@" and lower case: PayPal
 * treats handles case-insensitively, so one spelling keeps the link stable.
 */
export function optionalPaypalMeHandle(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a string`);
  }
  const handle = value.trim().replace(/^@/, '');
  if (!PAYPAL_ME_HANDLE.test(handle)) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be your PayPal.Me handle (3-40 letters, digits, . _ -)`,
    );
  }
  return handle.toLowerCase();
}

export function optionalDate(
  source: Record<string, unknown>,
  key: string,
): Date | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be an ISO date`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} is not a valid date`);
  }
  return date;
}
