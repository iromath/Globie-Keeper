import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/pool.js';
import { workerStatus } from '../jobs/boss.js';
import { config, isProduction } from '../lib/config.js';

type DbProbe = {
  ok: boolean;
  timescale: string | null;
  hypertables: number;
  error?: string;
};

async function probeDatabase(): Promise<DbProbe> {
  try {
    const version = await query<{ extversion: string }>(
      `select extversion from pg_extension where extname = 'timescaledb'`,
    );
    const hypertables = version.rowCount
      ? await query<{ count: number }>(
          `select count(*)::int as count from timescaledb_information.hypertables`,
        )
      : null;

    return {
      ok: true,
      timescale: version.rows[0]?.extversion ?? null,
      hypertables: hypertables?.rows[0]?.count ?? 0,
    };
  } catch (error) {
    return { ok: false, timescale: null, hypertables: 0, error: (error as Error).message };
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply) => {
    const database = await probeDatabase();
    const worker = workerStatus();
    const healthy = database.ok && worker.ok;
    const body = {
      status: healthy ? 'ok' : 'degraded',
      service: 'globie-keeper-api',
      env: config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      database,
      worker,
    };
    return reply.code(healthy ? 200 : 503).send(body);
  });

  if (!isProduction) {
    app.get('/health/ready', async (_request, reply) => {
      const database = await probeDatabase();
      return reply.code(database.ok ? 200 : 503).send({ ready: database.ok });
    });
  }
};
