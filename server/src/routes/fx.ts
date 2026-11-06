import type { FastifyPluginAsync } from 'fastify';

import { getRates } from '../lib/fx.js';

/**
 * Indicative display rates (DEV_PLAN §2.19). Public: the client needs a rate
 * before it is signed in, and nothing here is user data.
 */
export const fxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/fx/rates', async (request) => {
    const { base } = request.query as { base?: string };
    return getRates(base);
  });
};
