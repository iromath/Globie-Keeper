/**
 * The in-app manual (DEV_PLAN §2.22).
 *
 * Public on purpose: the sections hold no user data, so the Help page can render
 * them before sign-in, and the response is safe to cache. The same source feeds
 * Globie's prompt (lib/assistant.ts).
 */

import type { FastifyPluginAsync } from 'fastify';

import { MANUAL } from '../lib/manual.js';

export const helpRoutes: FastifyPluginAsync = async (app) => {
  app.get('/help', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return { sections: MANUAL };
  });
};
