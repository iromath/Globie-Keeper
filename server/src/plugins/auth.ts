import type { FastifyInstance, FastifyRequest } from 'fastify';

import { query } from '../db/pool.js';
import { ApiError } from '../lib/http-error.js';
import { hashToken } from '../lib/ids.js';

export type AuthUser = {
  userId: string;
  email: string;
  displayName: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthUser | null;
  }
}

type SessionRow = {
  user_id: string;
  email: string;
  display_name: string;
};

async function resolveSession(request: FastifyRequest): Promise<AuthUser | null> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;

  const token = header.slice('Bearer '.length).trim();
  if (token.length < 16 || token.length > 200) return null;

  const { rows } = await query<SessionRow>(
    `select u.id as user_id, u.email, u.display_name
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) return null;
  return { userId: row.user_id, email: row.email, displayName: row.display_name };
}

/** Every route resolves an optional session, then guards what it needs. */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = await resolveSession(request);
  });
}

export function currentUser(request: FastifyRequest): AuthUser | null {
  return request.auth;
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.auth) throw ApiError.unauthorized();
  return request.auth;
}
