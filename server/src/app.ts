import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { config, isProduction } from './lib/config.js';
import { ApiError } from './lib/http-error.js';
import { authPlugin } from './plugins/auth.js';
import { agentRoutes } from './routes/agent.js';
import { agreementRoutes } from './routes/agreements.js';
import { authRoutes } from './routes/auth.js';
import { billRoutes } from './routes/bills.js';
import { donationRoutes } from './routes/donations.js';
import { fxRoutes } from './routes/fx.js';
import { groupRoutes } from './routes/groups.js';
import { healthRoutes } from './routes/health.js';
import { helpRoutes } from './routes/help.js';
import { meRoutes } from './routes/me.js';
import { paypalRoutes } from './routes/paypal.js';
import { shareRoutes } from './routes/shares.js';
import { tipRoutes } from './routes/tips.js';

const allowedOrigins = new Set([
  config.publicOrigin,
  config.webOrigin,
  'http://localhost:8081',
  'http://localhost:19006',
  'http://localhost:3001',
  ...config.corsOrigins,
]);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: isProduction ? 'info' : 'debug' },
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  // PayPal signs the exact bytes it sends, so keep the raw body while still
  // handing routes the parsed JSON. 1 MB stays the global limit.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  await app.register(cors, {
    // @fastify/cors only advertises the safelisted methods by default, which
    // makes the browser reject `PATCH /bills/:id/allocations` at preflight.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    origin: (origin, callback) => {
      // Native apps and server-to-server calls send no Origin header.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new ApiError(403, 'origin_not_allowed', 'Origin not allowed'), false);
    },
  });

  // Receipt photos and videos: 25 MB per file, one file per request.
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // Container healthcheck hits /health; the client hits /api/health through the proxy.
  await app.register(healthRoutes);
  await app.register(healthRoutes, { prefix: '/api' });

  // Session lookup runs before every route; each route guards what it needs.
  // Called directly (not via register) so the onRequest hook is not encapsulated
  // away from the routes registered below.
  await authPlugin(app);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(groupRoutes, { prefix: '/api' });
  await app.register(agreementRoutes, { prefix: '/api' });
  await app.register(billRoutes, { prefix: '/api' });
  await app.register(fxRoutes, { prefix: '/api' });
  await app.register(helpRoutes, { prefix: '/api' });
  await app.register(meRoutes, { prefix: '/api' });
  await app.register(shareRoutes, { prefix: '/api' });
  await app.register(tipRoutes, { prefix: '/api' });
  await app.register(donationRoutes, { prefix: '/api' });
  await app.register(paypalRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 'not_found',
      message: `No route for ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled request error');

    return reply.code(status).send({
      code: error.code ?? 'internal_error',
      message: status >= 500 && isProduction ? 'Something went wrong' : error.message,
    });
  });

  return app;
}
