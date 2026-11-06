import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Opaque bearer token handed to the client. Only its hash is stored. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * OAuth `state` values and one-time handoff codes: 32 random bytes that only
 * ever reach the database as a hash (DEV_PLAN §2.17).
 */
export function createOpaqueCode(): string {
  return randomBytes(32).toString('base64url');
}

/** Short, human-readable invite code shown in the group screen. */
export function createInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

export function newId(): string {
  return randomUUID();
}
