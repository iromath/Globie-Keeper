import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing (DEV_PLAN §2.17).
 *
 * Node ships `scrypt`, so the API gets a memory-hard KDF without a dependency
 * and without the native build that `bcrypt`/`argon2` need. The stored string
 * carries its own parameters, which means the cost can be raised later without
 * a migration: old rows keep verifying with the values they were written with.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>`
 */

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** 128 * N * r = 16 MiB; give scrypt room for its own overhead. */
const MAX_MEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function isAcceptablePassword(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return [
    'scrypt',
    String(N),
    String(R),
    String(P),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** Constant-time compare; a malformed or unknown hash is simply a mismatch. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || r < 1 || p < 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  const actual = await derive(password, salt, n, r, p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
