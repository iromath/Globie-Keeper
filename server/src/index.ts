import { buildApp } from './app.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { startJobs, stopJobs } from './jobs/boss.js';
import { config } from './lib/config.js';

const app = await buildApp();

if (config.autoMigrate) {
  await runMigrations();
}

// Migrations have to land first: both queues live in the same database.
await startJobs();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app
      .close()
      .then(() => stopJobs())
      .then(() => closePool())
      .finally(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
